import { sha1Hex, sha512Hex } from "./crypto";
import { fetchWithFallback, formatBytes, type FetchOptions } from "./download";
import {
  describeComponent,
  inferLoaderSlugFromProfileId,
  inferMinecraftVersionFromProfileId,
  modrinthLoaderSlugsForUid,
  primaryLoaderComponent,
} from "./prism";
import {
  findInstalledByProjectId,
  installDownloadedResource,
  isResourceFileName,
  listResourceTargets,
  safeResourceFileName,
  type InstalledResource,
  type ResourceKind,
  type ResourceTarget,
} from "./resources";
import type { InstanceSummary, LogListener, ProgressListener } from "./types";

export const MODRINTH_API_BASE = "https://api.modrinth.com/v2";

export interface ModrinthSearchHit {
  project_id: string;
  project_type?: string;
  all_project_types?: string[];
  slug?: string;
  title: string;
  description?: string;
  author?: string;
  downloads?: number;
  follows?: number;
  icon_url?: string | null;
  versions?: string[];
  categories?: string[];
  display_categories?: string[];
  date_modified?: string;
  latest_version?: string;
}

interface ModrinthSearchResponse {
  hits: ModrinthSearchHit[];
  offset: number;
  limit: number;
  total_hits: number;
}

export interface ModrinthProject {
  id: string;
  slug?: string;
  title: string;
  project_type?: string;
  description?: string;
}

export interface ModrinthVersionFile {
  hashes: { sha1?: string; sha512?: string };
  url: string;
  filename: string;
  primary: boolean;
  size: number;
  file_type?: string | null;
}

export interface ModrinthDependency {
  project_id?: string;
  version_id?: string;
  dependency_type: string;
}

export interface ModrinthVersion {
  id: string;
  project_id: string;
  name: string;
  version_number: string;
  game_versions: string[];
  loaders: string[];
  version_type: string;
  featured?: boolean;
  status?: string;
  date_published: string;
  files: ModrinthVersionFile[];
  dependencies?: ModrinthDependency[];
}

export interface ModrinthContext {
  minecraftVersion: string;
  loaderUid?: string;
  loaderName?: string;
  loaderSlugs: string[];
}

export function modrinthContextForInstance(instance: InstanceSummary): ModrinthContext {
  const loader = primaryLoaderComponent(instance.components);
  const minecraftComponent = instance.components.find((component) => component.uid === "net.minecraft");
  const componentMinecraftVersion = minecraftComponent?.version ?? minecraftComponent?.cachedVersion;
  const rawMinecraftVersion = componentMinecraftVersion ?? instance.minecraftVersion;
  const minecraftVersion = inferMinecraftVersionFromProfileId(rawMinecraftVersion) ?? rawMinecraftVersion;
  if (loader) {
    return {
      minecraftVersion,
      loaderUid: loader.uid,
      loaderName: describeComponent(loader.uid),
      loaderSlugs: modrinthLoaderSlugsForUid(loader.uid),
    };
  }
  const inferred = inferLoaderSlugFromProfileId(instance.minecraftVersion);
  return {
    minecraftVersion,
    loaderName: inferred,
    loaderSlugs: inferred ? (inferred === "quilt" ? ["quilt", "fabric"] : [inferred]) : [],
  };
}

export function buildModrinthFacets(kind: ResourceKind, context: ModrinthContext): string[][] {
  const facets: string[][] = [];
  if (kind === "mods") {
    facets.push(["project_type:mod"]);
    if (context.loaderSlugs.length) facets.push(context.loaderSlugs.map((slug) => `categories:${slug}`));
  } else if (kind === "resourcepacks") {
    facets.push(["project_type:resourcepack"]);
  } else if (kind === "shaderpacks") {
    facets.push(["project_type:shader"]);
  } else {
    facets.push(["all_project_types:datapack"], ["categories:datapack"]);
  }
  if (context.minecraftVersion) facets.push([`versions:${context.minecraftVersion}`]);
  return facets;
}

function channelRank(version: ModrinthVersion): number {
  if (version.version_type === "release") return 0;
  if (version.version_type === "beta") return 1;
  return 2;
}

export function primaryModrinthFile(version: ModrinthVersion): ModrinthVersionFile | undefined {
  return version.files.find((file) => file.primary) ?? version.files.find((file) => !file.file_type) ?? version.files[0];
}

function versionHasInstallableFile(kind: ResourceKind, version: ModrinthVersion): boolean {
  const file = primaryModrinthFile(version);
  return Boolean(file && isResourceFileName(kind, safeResourceFileName(file.filename)));
}

export function pickPreferredModrinthVersion(kind: ResourceKind, versions: ModrinthVersion[]): ModrinthVersion | undefined {
  return [...versions]
    .filter((version) => (!version.status || version.status === "listed") && versionHasInstallableFile(kind, version))
    .sort((a, b) => {
      const channel = channelRank(a) - channelRank(b);
      if (channel) return channel;
      if (Boolean(a.featured) !== Boolean(b.featured)) return a.featured ? -1 : 1;
      return Date.parse(b.date_published) - Date.parse(a.date_published);
    })[0];
}

export function resourceKindForModrinthProject(project: ModrinthProject, fallback: ResourceKind): ResourceKind {
  if (project.project_type === "resourcepack") return "resourcepacks";
  if (project.project_type === "shader") return "shaderpacks";
  if (project.project_type === "datapack") return "datapacks";
  // Many datapacks are represented as Modrinth "mod" projects, so in a
  // datapack installation we keep the datapack target unless version data
  // proves the dependency is a loader JAR (handled in the installer).
  if (project.project_type === "mod") return fallback === "datapacks" ? "datapacks" : "mods";
  return fallback;
}

export function resourceKindForModrinthVersion(version: ModrinthVersion, fallback: ResourceKind, loaderSlugs: string[]): ResourceKind {
  const file = primaryModrinthFile(version);
  const fileName = file ? safeResourceFileName(file.filename).toLowerCase() : "";
  if (version.loaders.includes("datapack") && fileName.endsWith(".zip")) return "datapacks";
  if (loaderSlugs.some((slug) => version.loaders.includes(slug)) && fileName.endsWith(".jar")) return "mods";
  return fallback;
}

export function sortModrinthVersions(kind: ResourceKind, versions: ModrinthVersion[]): ModrinthVersion[] {
  return [...versions]
    .filter((version) => versionHasInstallableFile(kind, version))
    .sort((a, b) => {
      const channel = channelRank(a) - channelRank(b);
      if (channel) return channel;
      if (Boolean(a.featured) !== Boolean(b.featured)) return a.featured ? -1 : 1;
      return Date.parse(b.date_published) - Date.parse(a.date_published);
    });
}

interface ModrinthServiceOptions {
  fetchOptions: () => FetchOptions;
  log: LogListener;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export class ModrinthService {
  private projects = new Map<string, ModrinthProject>();

  constructor(private readonly serviceOptions: ModrinthServiceOptions) {}

  private async getJson<T>(path: string): Promise<T> {
    const response = await fetchWithFallback(`${MODRINTH_API_BASE}${path}`, this.serviceOptions.fetchOptions(), {
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new Error(`Modrinth devolvió HTTP ${response.status} (${path})`);
    return (await response.json()) as T;
  }

  async search(
    kind: ResourceKind,
    context: ModrinthContext,
    query: string,
    sort: string,
    offset: number,
  ): Promise<{ hits: ModrinthSearchHit[]; total: number }> {
    const params = new URLSearchParams({
      limit: "30",
      offset: String(Math.max(0, offset)),
      index: sort || "relevance",
      facets: JSON.stringify(buildModrinthFacets(kind, context)),
    });
    if (query.trim()) params.set("query", query.trim());
    const response = await this.getJson<ModrinthSearchResponse>(`/search?${params.toString()}`);
    return { hits: response.hits ?? [], total: response.total_hits ?? 0 };
  }

  async getProject(projectId: string): Promise<ModrinthProject> {
    const cached = this.projects.get(projectId);
    if (cached) return cached;
    const project = await this.getJson<ModrinthProject>(`/project/${encodeURIComponent(projectId)}`);
    this.projects.set(projectId, project);
    return project;
  }

  async listVersions(projectId: string, kind: ResourceKind, context: ModrinthContext): Promise<ModrinthVersion[]> {
    const params = new URLSearchParams({ include_changelog: "false" });
    if (context.minecraftVersion) params.set("game_versions", JSON.stringify([context.minecraftVersion]));
    if (kind === "mods" && context.loaderSlugs.length) params.set("loaders", JSON.stringify(unique(context.loaderSlugs)));
    if (kind === "datapacks") params.set("loaders", JSON.stringify(["datapack"]));
    const versions = await this.getJson<ModrinthVersion[]>(`/project/${encodeURIComponent(projectId)}/version?${params.toString()}`);
    return sortModrinthVersions(kind, versions ?? []);
  }

  async getVersion(versionId: string): Promise<ModrinthVersion> {
    return this.getJson<ModrinthVersion>(`/version/${encodeURIComponent(versionId)}`);
  }

  async installPreferred(
    instance: InstanceSummary,
    kind: ResourceKind,
    target: ResourceTarget,
    projectIdOrHit: string | ModrinthSearchHit,
    context: ModrinthContext,
    onProgress?: ProgressListener,
  ): Promise<InstalledResource[]> {
    const project = typeof projectIdOrHit === "string" ? await this.getProject(projectIdOrHit) : {
      id: projectIdOrHit.project_id,
      slug: projectIdOrHit.slug,
      title: projectIdOrHit.title,
      project_type: projectIdOrHit.project_type,
    };
    const versions = await this.listVersions(project.id, kind, context);
    const version = pickPreferredModrinthVersion(kind, versions);
    if (!version) {
      throw new Error(`No hay archivos de ${project.title} compatibles con Minecraft ${context.minecraftVersion}${context.loaderSlugs.length ? ` + ${context.loaderSlugs.join("/")}` : ""}.`);
    }
    return this.installVersion(instance, kind, target, project, version, context, onProgress);
  }

  async installVersion(
    instance: InstanceSummary,
    kind: ResourceKind,
    target: ResourceTarget,
    project: ModrinthProject,
    version: ModrinthVersion,
    context: ModrinthContext,
    onProgress?: ProgressListener,
  ): Promise<InstalledResource[]> {
    const installed: InstalledResource[] = [];
    const visited = new Set<string>();
    await this.installVersionRecursive(instance, kind, target, project, version, context, visited, installed, onProgress);
    return installed;
  }

  private async installVersionRecursive(
    instance: InstanceSummary,
    kind: ResourceKind,
    target: ResourceTarget,
    project: ModrinthProject,
    version: ModrinthVersion,
    context: ModrinthContext,
    visited: Set<string>,
    installed: InstalledResource[],
    onProgress?: ProgressListener,
  ): Promise<void> {
    const visitKey = `${project.id}@${version.id}`;
    if (visited.has(visitKey)) return;
    visited.add(visitKey);

    // Required project dependencies first, like Prism's review/download flow.
    for (const dependency of version.dependencies ?? []) {
      if (dependency.dependency_type !== "required" || !dependency.project_id) continue;
      const alreadyInCurrentTarget = await findInstalledByProjectId(instance, kind, target, dependency.project_id).catch(() => undefined);
      if (alreadyInCurrentTarget) {
        this.serviceOptions.log(`Dependencia ya instalada: ${alreadyInCurrentTarget.displayName}.`);
        continue;
      }

      const dependencyProject = await this.getProject(dependency.project_id);
      let dependencyTargetKind = resourceKindForModrinthProject(dependencyProject, kind);
      let dependencyVersion: ModrinthVersion | undefined;
      if (dependency.version_id) {
        dependencyVersion = await this.getVersion(dependency.version_id);
      } else {
        dependencyVersion = pickPreferredModrinthVersion(
          dependencyTargetKind,
          await this.listVersions(dependencyProject.id, dependencyTargetKind, context),
        );
        // A datapack project can depend on an actual loader mod even though
        // both are Modrinth "mod" projects. Retry as a mod if there is no
        // datapack-tagged file for the dependency.
        if (!dependencyVersion && kind === "datapacks" && dependencyTargetKind === "datapacks" && dependencyProject.project_type === "mod") {
          dependencyTargetKind = "mods";
          dependencyVersion = pickPreferredModrinthVersion("mods", await this.listVersions(dependencyProject.id, "mods", context));
        }
      }
      if (!dependencyVersion) {
        throw new Error(`No se encontró una versión compatible de la dependencia requerida ${dependencyProject.title}.`);
      }

      dependencyTargetKind = resourceKindForModrinthVersion(dependencyVersion, dependencyTargetKind, context.loaderSlugs);
      const dependencyTarget = dependencyTargetKind === kind
        ? target
        : (await listResourceTargets(instance, dependencyTargetKind))[0];
      if (!dependencyTarget) throw new Error(`No hay carpeta destino para la dependencia ${dependencyProject.title}.`);
      const alreadyInstalled = await findInstalledByProjectId(instance, dependencyTargetKind, dependencyTarget, dependency.project_id).catch(() => undefined);
      if (alreadyInstalled) {
        this.serviceOptions.log(`Dependencia ya instalada: ${alreadyInstalled.displayName}.`);
        continue;
      }

      this.serviceOptions.log(`Instalando dependencia requerida: ${dependencyProject.title} ${dependencyVersion.version_number}.`);
      await this.installVersionRecursive(instance, dependencyTargetKind, dependencyTarget, dependencyProject, dependencyVersion, context, visited, installed, onProgress);
    }

    const primary = primaryModrinthFile(version);
    if (!primary) throw new Error(`${project.title} ${version.version_number} no tiene archivo principal.`);
    onProgress?.({ phase: `Descargando ${project.title}`, done: 0, total: primary.size || 1, current: primary.filename, bytesDone: 0, bytesTotal: primary.size });
    const blob = await this.downloadAndVerify(primary);
    const resource = await installDownloadedResource(instance, kind, target, primary.filename, blob, {
      provider: "modrinth",
      projectId: project.id,
      projectSlug: project.slug,
      projectTitle: project.title,
      versionId: version.id,
      versionNumber: version.version_number,
      sha1: primary.hashes.sha1,
      sha512: primary.hashes.sha512,
    });
    installed.push(resource);
    this.serviceOptions.log(`${project.title} ${version.version_number} instalado: ${primary.filename} (${formatBytes(primary.size)}).`, "ok");

    // Modrinth data packs can carry a required resource pack as an extra file.
    for (const file of version.files) {
      if (file === primary || file.file_type !== "required-resource-pack") continue;
      const [resourcePackTarget] = await listResourceTargets(instance, "resourcepacks");
      const extraBlob = await this.downloadAndVerify(file);
      const extra = await installDownloadedResource(instance, "resourcepacks", resourcePackTarget, file.filename, extraBlob, {
        provider: "modrinth",
        projectId: project.id,
        projectSlug: project.slug,
        projectTitle: `${project.title} (resource pack requerido)`,
        versionId: version.id,
        versionNumber: version.version_number,
        sha1: file.hashes.sha1,
        sha512: file.hashes.sha512,
      });
      installed.push(extra);
      this.serviceOptions.log(`Resource pack requerido instalado: ${file.filename}.`, "ok");
    }
  }

  private async downloadAndVerify(file: ModrinthVersionFile): Promise<Blob> {
    const response = await fetchWithFallback(file.url, this.serviceOptions.fetchOptions());
    if (!response.ok) throw new Error(`HTTP ${response.status} al descargar ${file.filename} desde Modrinth.`);
    const blob = await response.blob();
    if (file.size && blob.size !== file.size) {
      throw new Error(`Tamaño inesperado para ${file.filename}: esperado ${file.size}, obtenido ${blob.size}.`);
    }
    if (file.hashes.sha512) {
      const actual = await sha512Hex(blob);
      if (actual.toLowerCase() !== file.hashes.sha512.toLowerCase()) throw new Error(`SHA-512 no coincide para ${file.filename}.`);
    } else if (file.hashes.sha1) {
      const actual = await sha1Hex(blob);
      if (actual.toLowerCase() !== file.hashes.sha1.toLowerCase()) throw new Error(`SHA-1 no coincide para ${file.filename}.`);
    }
    return blob;
  }
}
