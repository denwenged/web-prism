import { sha256Hex } from "./crypto";
import { fetchWithFallback, type FetchOptions } from "./download";
import { CACHE_ROOT } from "./instances";
import type { PrismMetaRequirement, PrismPatchJson } from "./mojang";
import { opfs } from "./opfs";
import type { LogListener } from "./types";

export const PRISM_META_DEFAULT_BASE_URL = "https://meta.prismlauncher.org/v1/";

export interface PrismMetaVersionEntry {
  version: string;
  releaseTime: string;
  type?: string;
  recommended?: boolean;
  volatile?: boolean;
  sha256?: string;
  requires?: PrismMetaRequirement[];
  conflicts?: PrismMetaRequirement[];
}

export interface PrismMetaVersionList {
  formatVersion: number;
  name: string;
  uid: string;
  versions: PrismMetaVersionEntry[];
}

export interface LoaderDefinition {
  uid: string;
  label: string;
  slug?: string;
}

export const LOADER_DEFINITIONS: LoaderDefinition[] = [
  { uid: "", label: "Ninguno (Vanilla)" },
  { uid: "net.neoforged", label: "NeoForge", slug: "neoforge" },
  { uid: "net.minecraftforge", label: "Forge", slug: "forge" },
  { uid: "net.fabricmc.fabric-loader", label: "Fabric", slug: "fabric" },
  { uid: "org.quiltmc.quilt-loader", label: "Quilt", slug: "quilt" },
  { uid: "com.mumfrey.liteloader", label: "LiteLoader", slug: "liteloader" },
];

export function loaderDefinition(uid: string): LoaderDefinition | undefined {
  return LOADER_DEFINITIONS.find((definition) => definition.uid === uid);
}

export function loaderSupportsMinecraft(uid: string, minecraftVersion: string): boolean {
  if (uid !== "net.fabricmc.fabric-loader" && uid !== "org.quiltmc.quilt-loader") return true;
  const oneDot = /^1\.(\d+)(?:\.|$)/.exec(minecraftVersion);
  if (oneDot) return Number(oneDot[1]) >= 14;
  if (/^[2-9]\d*(?:\.|$)/.test(minecraftVersion)) return true;
  if (/^\d{2}w\d{2}[a-z]$/i.test(minecraftVersion)) return true;
  if (/^\d+\.\d+(?:\.\d+)?(?:-(?:pre|rc|snapshot))/i.test(minecraftVersion)) return true;
  return false;
}

function minecraftRequirement(entry: PrismMetaVersionEntry): PrismMetaRequirement | undefined {
  return entry.requires?.find((requirement) => requirement.uid === "net.minecraft");
}

export function metaEntrySupportsMinecraft(entry: PrismMetaVersionEntry, minecraftVersion: string): boolean {
  const requirement = minecraftRequirement(entry);
  return !requirement?.equals || requirement.equals === minecraftVersion;
}

export function filterMetaVersionsForMinecraft(
  uid: string,
  entries: PrismMetaVersionEntry[],
  minecraftVersion: string,
): PrismMetaVersionEntry[] {
  if (!loaderSupportsMinecraft(uid, minecraftVersion)) return [];
  return [...entries]
    .filter((entry) => metaEntrySupportsMinecraft(entry, minecraftVersion))
    .sort((a, b) => Date.parse(b.releaseTime) - Date.parse(a.releaseTime));
}

export function chooseMetaEntry(
  uid: string,
  entries: PrismMetaVersionEntry[],
  minecraftVersion: string,
  requirement?: PrismMetaRequirement,
  requestedVersion?: string,
): PrismMetaVersionEntry | undefined {
  const compatible = filterMetaVersionsForMinecraft(uid, entries, minecraftVersion);
  const exact = requestedVersion ?? requirement?.equals;
  if (exact) return compatible.find((entry) => entry.version === exact);
  if (requirement?.suggests) {
    const suggested = compatible.find((entry) => entry.version === requirement.suggests);
    if (suggested) return suggested;
  }
  return compatible.find((entry) => entry.recommended) ?? compatible.find((entry) => entry.type === "release") ?? compatible[0];
}

export interface ResolvedMetaComponent {
  uid: string;
  version: string;
  name: string;
  entry: PrismMetaVersionEntry;
  patch: PrismPatchJson;
  dependencyOnly: boolean;
}

interface PrismMetaServiceOptions {
  proxyBase: () => string;
  baseUrl: () => string;
  log?: LogListener;
}

function normalizedBaseUrl(value: string): string {
  const trimmed = value.trim() || PRISM_META_DEFAULT_BASE_URL;
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

function safeCacheVersionFile(version: string): string {
  return `${encodeURIComponent(version)}.json`;
}

export class PrismMetaService {
  private lists = new Map<string, PrismMetaVersionList>();
  private patches = new Map<string, PrismPatchJson>();

  constructor(private readonly serviceOptions: PrismMetaServiceOptions) {}

  private fetchOptions(): FetchOptions {
    return { proxyBase: this.serviceOptions.proxyBase() };
  }

  private url(path: string): string {
    return `${normalizedBaseUrl(this.serviceOptions.baseUrl())}${path.replace(/^\/+/, "")}`;
  }

  private async fetchText(url: string, cachePath?: string, expectedSha256?: string, forceRefresh = false): Promise<string> {
    if (cachePath && !forceRefresh) {
      const cached = await opfs.readOptionalText(cachePath).catch(() => null);
      if (cached) {
        if (!expectedSha256) {
          // Lists are verified by their containing index only in desktop Prism.
          // Returning the OPFS copy makes repeated dialogs instant; callers can
          // forceRefresh from the Refresh button. Still, if there is a hash in
          // the version entry we validate it below.
          if (!url.endsWith("/index.json")) return cached;
          // For lists, fall through to a live request once per page session is
          // handled by the in-memory cache in getVersionList; disk is fallback.
        } else if ((await sha256Hex(new TextEncoder().encode(cached))) === expectedSha256.toLowerCase()) {
          return cached;
        }
      }
    }

    try {
      const response = await fetchWithFallback(url, this.fetchOptions(), { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      if (expectedSha256) {
        const actual = await sha256Hex(new TextEncoder().encode(text));
        if (actual !== expectedSha256.toLowerCase()) {
          throw new Error(`SHA-256 no coincide para ${url}: esperado ${expectedSha256}, obtenido ${actual}`);
        }
      }
      if (cachePath) await opfs.writeText(cachePath, text).catch(() => undefined);
      return text;
    } catch (error) {
      if (cachePath) {
        const cached = await opfs.readOptionalText(cachePath).catch(() => null);
        if (cached) {
          if (expectedSha256 && (await sha256Hex(new TextEncoder().encode(cached))) !== expectedSha256.toLowerCase()) throw error;
          this.serviceOptions.log?.(`No se pudo actualizar Prism Meta; usando caché para ${url}.`, "warn");
          return cached;
        }
      }
      throw new Error(`No se pudo descargar Prism Meta (${url}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async getVersionList(uid: string, forceRefresh = false): Promise<PrismMetaVersionList> {
    const key = `${normalizedBaseUrl(this.serviceOptions.baseUrl())}:${uid}`;
    if (!forceRefresh && this.lists.has(key)) return this.lists.get(key)!;
    const cachePath = `${CACHE_ROOT}/prism-meta/${uid}/index.json`;
    const text = await this.fetchText(this.url(`${uid}/index.json`), cachePath, undefined, forceRefresh);
    const parsed = JSON.parse(text) as PrismMetaVersionList;
    if (parsed.uid !== uid || !Array.isArray(parsed.versions)) {
      throw new Error(`La lista Prism Meta de ${uid} tiene un formato inesperado.`);
    }
    parsed.versions = [...parsed.versions].sort((a, b) => Date.parse(b.releaseTime) - Date.parse(a.releaseTime));
    this.lists.set(key, parsed);
    return parsed;
  }

  async listLoaderVersions(uid: string, minecraftVersion: string, forceRefresh = false): Promise<PrismMetaVersionEntry[]> {
    const list = await this.getVersionList(uid, forceRefresh);
    return filterMetaVersionsForMinecraft(uid, list.versions, minecraftVersion);
  }

  async getPatch(uid: string, version: string, expectedSha256?: string, forceRefresh = false): Promise<PrismPatchJson> {
    const key = `${normalizedBaseUrl(this.serviceOptions.baseUrl())}:${uid}@${version}`;
    if (!forceRefresh && this.patches.has(key)) return this.patches.get(key)!;
    const cachePath = `${CACHE_ROOT}/prism-meta/${uid}/${safeCacheVersionFile(version)}`;
    const text = await this.fetchText(this.url(`${uid}/${encodeURIComponent(version)}.json`), cachePath, expectedSha256, forceRefresh);
    const parsed = JSON.parse(text) as PrismPatchJson;
    const parsedUid = parsed.uid ?? parsed.fileId;
    if (parsedUid && parsedUid !== uid) throw new Error(`El patch descargado es ${parsedUid}, pero se pidió ${uid}.`);
    if (parsed.version && parsed.version !== version) {
      throw new Error(`El patch descargado es la versión ${parsed.version}, pero se pidió ${version}.`);
    }
    const patch: PrismPatchJson = { ...parsed, uid, version };
    this.patches.set(key, patch);
    return patch;
  }

  /**
   * Resolves one meta component and its component-level dependencies.
   * Dependencies are returned first, like Prism's component application order.
   */
  async resolveComponent(
    uid: string,
    version: string | undefined,
    minecraftVersion: string,
    options: { forceRefresh?: boolean } = {},
  ): Promise<ResolvedMetaComponent[]> {
    const output: ResolvedMetaComponent[] = [];
    const completed = new Set<string>();
    const visiting = new Set<string>();

    const visit = async (
      currentUid: string,
      requestedVersion: string | undefined,
      requirement: PrismMetaRequirement | undefined,
      dependencyOnly: boolean,
    ): Promise<void> => {
      if (completed.has(currentUid)) return;
      if (visiting.has(currentUid)) throw new Error(`Dependencia circular en Prism Meta: ${currentUid}`);
      visiting.add(currentUid);
      try {
        const list = await this.getVersionList(currentUid, options.forceRefresh ?? false);
        let entry = chooseMetaEntry(currentUid, list.versions, minecraftVersion, requirement, requestedVersion);
        if (!entry && requestedVersion) {
          entry = list.versions.find((candidate) => candidate.version === requestedVersion);
          if (entry && !metaEntrySupportsMinecraft(entry, minecraftVersion)) {
            throw new Error(`${list.name} ${requestedVersion} no es compatible con Minecraft ${minecraftVersion}.`);
          }
        }
        if (!entry) {
          throw new Error(`No hay ninguna versión de ${list.name} compatible con Minecraft ${minecraftVersion}.`);
        }

        const patch = await this.getPatch(currentUid, entry.version, entry.sha256, options.forceRefresh ?? false);
        const requirements = patch.requires?.length ? patch.requires : entry.requires ?? [];
        for (const dependency of requirements) {
          if (dependency.uid === "net.minecraft") {
            if (dependency.equals && dependency.equals !== minecraftVersion) {
              throw new Error(`${list.name} ${entry.version} requiere Minecraft ${dependency.equals}, no ${minecraftVersion}.`);
            }
            continue;
          }
          await visit(dependency.uid, dependency.equals, dependency, true);
        }

        output.push({
          uid: currentUid,
          version: entry.version,
          name: patch.name ?? list.name,
          entry,
          patch,
          dependencyOnly,
        });
        completed.add(currentUid);
      } finally {
        visiting.delete(currentUid);
      }
    };

    await visit(uid, version, undefined, false);
    return output;
  }

  async resolveLoader(uid: string, version: string, minecraftVersion: string): Promise<ResolvedMetaComponent[]> {
    return this.resolveComponent(uid, version, minecraftVersion);
  }
}
