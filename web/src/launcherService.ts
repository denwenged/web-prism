import { offlineUuid } from "./crypto";
import { Downloader, formatBytes, runPool, type EnsureFileSource } from "./download";
import { CACHE_ROOT, instanceRoot } from "./instances";
import { readFromSharedCache } from "./localFolder";
import {
  applyPrismPatch,
  assessCompatibility,
  assetObjectRelativePath,
  classifyLibraries,
  expandArguments,
  legacyAssetIndexUrl,
  libraryArtifact,
  resolveVersionProfile,
  substituteArguments,
  tokenizeLegacyArguments,
  webRuleContext,
  type AssetIndexJson,
  type Compatibility,
  type MojangVersionManifest,
  type PrismPatchJson,
  type ResolvedProfile,
  type VersionJson,
} from "./mojang";
import { cheerpjAppPath, opfs } from "./opfs";
import { slugifyInstanceId } from "./prism";
import type { InstanceSummary, LogListener, ProgressListener } from "./types";

const MANIFEST_URL = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
const RESOURCES_BASE = "https://resources.download.minecraft.net/";

export interface ResolvedInstanceProfile {
  profile: ResolvedProfile;
  compatibility: Compatibility;
  classified: ReturnType<typeof classifyLibraries>;
  missingPatchComponents: string[];
}

export interface LaunchPlan {
  instanceId: string;
  instanceName: string;
  username: string;
  uuid: string;
  profile: ResolvedProfile;
  compatibility: Compatibility;
  classpathJvmPaths: string[];
  classpath: string;
  gameArgs: string[];
  ignoredJvmArgs: string[];
  javaProperties: string[];
  gameDirJvmPath: string;
  assetsDirJvmPath: string;
  assetIndexId: string;
  stageAssetsToResourcesFromOpfs?: string;
  downloads: {
    files: number;
    bytes: number;
    bySource: Record<EnsureFileSource, number>;
  };
  createdAt: string;
}

interface LauncherServiceOptions {
  proxyBase: () => string;
  concurrency: () => number;
  log: LogListener;
}

function versionCacheId(id: string): string {
  return slugifyInstanceId(id);
}

function addArgPairIfMissing(args: string[], flag: string, value: string): void {
  if (!args.includes(flag)) args.push(flag, value);
}

function hasArgPair(args: string[], flag: string, value?: string): boolean {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === flag && (value === undefined || args[i + 1] === value)) return true;
  }
  return false;
}

export class LauncherService {
  private manifest: MojangVersionManifest | null = null;

  constructor(private readonly serviceOptions: LauncherServiceOptions) {}

  private downloader(): Downloader {
    return new Downloader(
      { proxyBase: this.serviceOptions.proxyBase() },
      { getFile: (candidates) => readFromSharedCache(candidates) },
    );
  }

  async getManifest(forceRefresh = false): Promise<MojangVersionManifest> {
    if (this.manifest && !forceRefresh) return this.manifest;

    const cachePath = `${CACHE_ROOT}/version_manifest_v2.json`;
    try {
      const manifest = await this.downloader().fetchJson<MojangVersionManifest>(MANIFEST_URL);
      this.manifest = manifest;
      await opfs.writeJson(cachePath, manifest).catch(() => undefined);
      return manifest;
    } catch (error) {
      const cached = await opfs.readOptionalJson<MojangVersionManifest>(cachePath);
      if (cached) {
        this.serviceOptions.log("No se pudo actualizar el manifiesto de Mojang; usando la copia en caché OPFS.", "warn");
        this.manifest = cached;
        return cached;
      }
      throw error;
    }
  }

  async getVersionJson(id: string): Promise<VersionJson> {
    const cacheId = versionCacheId(id);
    const cachePath = `${CACHE_ROOT}/versions/${cacheId}/${cacheId}.json`;
    const cached = await opfs.readOptionalJson<VersionJson>(cachePath);
    if (cached) return cached;

    const localFile = await readFromSharedCache([`versions/${id}/${id}.json`, `versions/${cacheId}/${cacheId}.json`]);
    if (localFile) {
      const parsed = JSON.parse(await localFile.text()) as VersionJson;
      await opfs.writeFile(cachePath, localFile);
      this.serviceOptions.log(`Perfil de versión ${id} leído desde la carpeta local vinculada.`);
      return parsed;
    }

    const manifest = await this.getManifest();
    const entry = manifest.versions.find((version) => version.id === id);
    if (!entry) {
      throw new Error(`La versión «${id}» no está en el manifiesto de Mojang ni en la caché local. Si es Forge/Fabric, importa antes una carpeta .minecraft que la contenga.`);
    }

    const version = await this.downloader().fetchJson<VersionJson>(entry.url);
    await opfs.writeJson(cachePath, version);
    return version;
  }

  async listCachedVersionIds(): Promise<string[]> {
    const entries = await opfs.list(`${CACHE_ROOT}/versions`);
    const ids: string[] = [];
    for (const entry of entries) {
      if (entry.kind !== "directory") continue;
      if (await opfs.fileExists(`${CACHE_ROOT}/versions/${entry.name}/${entry.name}.json`)) ids.push(entry.name);
    }
    return ids.sort((a, b) => a.localeCompare(b));
  }

  async resolveInstance(instance: InstanceSummary): Promise<ResolvedInstanceProfile> {
    if (!instance.minecraftVersion) {
      throw new Error("La instancia no tiene componente net.minecraft en mmc-pack.json. Elige una versión primero.");
    }

    let profile = await resolveVersionProfile(instance.minecraftVersion, this);
    const missingPatchComponents: string[] = [];

    for (const component of instance.components) {
      if (component.disabled || component.uid === "net.minecraft") continue;
      const patchPath = `${instanceRoot(instance.id)}/patches/${component.uid}.json`;
      const patch = await opfs.readOptionalJson<PrismPatchJson>(patchPath);
      if (!patch) {
        missingPatchComponents.push(component.uid);
        continue;
      }
      profile = applyPrismPatch(profile, patch);
    }

    if (missingPatchComponents.length) {
      profile.warnings.push(
        `Componente(s) sin patch local en patches/: ${missingPatchComponents.join(", ")}. Prism de escritorio los resuelve desde su servidor meta; WebPrism aún no implementa ese resolutor, así que ese loader puede no arrancar.`,
      );
    }

    const classified = classifyLibraries(profile, webRuleContext(true));
    const compatibility = assessCompatibility(profile, classified);
    return { profile, compatibility, classified, missingPatchComponents };
  }

  async prepareLaunchPlan(
    instance: InstanceSummary,
    options: {
      username: string;
      width: number;
      height: number;
      onProgress?: ProgressListener;
    },
  ): Promise<LaunchPlan> {
    const { profile, compatibility, classified } = await this.resolveInstance(instance);
    const downloader = this.downloader();
    const concurrency = Math.max(1, Math.min(16, this.serviceOptions.concurrency() || 8));
    const downloads = {
      files: 0,
      bytes: 0,
      bySource: { cache: 0, local: 0, opfs: 0, download: 0 } as Record<EnsureFileSource, number>,
    };
    const noteDownload = (source: EnsureFileSource, size: number) => {
      downloads.files += 1;
      downloads.bytes += size;
      downloads.bySource[source] += 1;
    };

    this.serviceOptions.log(`Perfil resuelto: ${profile.sourceChain.join(" -> ")} · Java ${profile.javaMajor} · ${profile.libraries.length} librerías.`);
    for (const blocker of compatibility.blockers) this.serviceOptions.log(`Bloqueo de runtime: ${blocker}`, "warn");

    const classpathOpfsPaths: string[] = [];

    // 1. Client / main jar.
    let clientOpfsPath: string | undefined;
    if (profile.mainJarLibrary) {
      const artifact = libraryArtifact(profile.mainJarLibrary);
      if (!artifact) throw new Error("El mainJar del patch no tiene artefacto descargable.");
      clientOpfsPath = `${CACHE_ROOT}/libraries/${artifact.path}`;
      options.onProgress?.({ phase: "Descargando cliente", done: 0, total: 1, current: profile.mainJarLibrary.name });
      const result = await downloader.ensureFile({
        label: `mainJar ${profile.mainJarLibrary.name}`,
        opfsPath: clientOpfsPath,
        url: artifact.url,
        sha1: artifact.sha1,
        size: artifact.size,
        localCandidates: [`libraries/${artifact.path}`],
      });
      noteDownload(result.source, result.size);
    } else if (profile.clientDownload) {
      const clientVersion = versionCacheId(profile.clientVersionId);
      clientOpfsPath = `${CACHE_ROOT}/versions/${clientVersion}/${clientVersion}.jar`;
      options.onProgress?.({ phase: "Descargando cliente", done: 0, total: 1, current: `Minecraft ${profile.clientVersionId}` });
      const result = await downloader.ensureFile(
        {
          label: `cliente Minecraft ${profile.clientVersionId}`,
          opfsPath: clientOpfsPath,
          url: profile.clientDownload.url,
          sha1: profile.clientDownload.sha1,
          size: profile.clientDownload.size,
          localCandidates: [`versions/${profile.clientVersionId}/${profile.clientVersionId}.jar`, `versions/${clientVersion}/${clientVersion}.jar`],
        },
        (received, total) => options.onProgress?.({ phase: "Descargando cliente", done: received, total: total ?? profile.clientDownload?.size ?? received, current: `Minecraft ${profile.clientVersionId}`, bytesDone: received, bytesTotal: total }),
      );
      noteDownload(result.source, result.size);
      this.serviceOptions.log(`Cliente ${profile.clientVersionId}: ${result.source === "download" ? "descargado de Mojang" : result.source === "local" ? "copiado de la carpeta local" : "en caché"} (${formatBytes(result.size)}).`);
    } else {
      throw new Error("El perfil resuelto no tiene cliente descargable.");
    }

    // 2. Java libraries. LWJGL2 Java jars are replaced by the wasm-matched build.
    const libraryEntries = classified.filter((entry) => entry.includeOnClasspath && entry.artifact && !entry.isLwjgl2);
    let libraryDone = 0;
    await runPool(libraryEntries, concurrency, async (entry) => {
      const artifact = entry.artifact!;
      const targetPath = `${CACHE_ROOT}/libraries/${artifact.path}`;
      const result = await downloader.ensureFile({
        label: `librería ${entry.library.name}`,
        opfsPath: targetPath,
        url: artifact.url,
        sha1: artifact.sha1,
        size: artifact.size,
        localCandidates: [`libraries/${artifact.path}`],
        opfsCandidates: [`${instanceRoot(instance.id)}/libraries/${artifact.path}`],
      });
      noteDownload(result.source, result.size);
      classpathOpfsPaths.push(targetPath);
      libraryDone += 1;
      options.onProgress?.({ phase: "Descargando librerías Java", done: libraryDone, total: libraryEntries.length, current: entry.library.name });
    });

    if (compatibility.hasLwjgl2) {
      this.serviceOptions.log("LWJGL2 detectado: se sustituyen los JAR de escritorio por LWJGL 2.9.3 + nativos wasm (ejecuta `npm run setup:runtime` si faltan).");
    }

    // Preserve a deterministic order close to Mojang's: libraries first, client last.
    const orderedClasspath = new Map<string, string>();
    for (const entry of classified) {
      if (!entry.includeOnClasspath || !entry.artifact || entry.isLwjgl2) continue;
      const path = `${CACHE_ROOT}/libraries/${entry.artifact.path}`;
      if (classpathOpfsPaths.includes(path)) orderedClasspath.set(path, cheerpjAppPath(path));
    }
    if (compatibility.hasLwjgl2) {
      orderedClasspath.set("__LWJGL_JAR__", "/app/lwjgl/lwjgl-2.9.3.jar");
      orderedClasspath.set("__LWJGL_UTIL__", "/app/lwjgl/lwjgl_util-2.9.3.jar");
    }
    if (clientOpfsPath) orderedClasspath.set(clientOpfsPath, cheerpjAppPath(clientOpfsPath));
    const classpathJvmPaths = [...orderedClasspath.values()];

    // 3. Assets.
    const assetIndex = profile.assetIndex;
    let assetIndexJson: AssetIndexJson | undefined;
    let assetsDirOpfsPath = `${CACHE_ROOT}/assets`;
    let stageAssetsToResourcesFromOpfs: string | undefined;

    if (assetIndex) {
      const url = legacyAssetIndexUrl(assetIndex);
      const indexPath = `${CACHE_ROOT}/assets/indexes/${assetIndex.id}.json`;
      const result = await downloader.ensureFile({
        label: `asset index ${assetIndex.id}`,
        opfsPath: indexPath,
        url,
        sha1: assetIndex.sha1,
        size: assetIndex.size,
        localCandidates: [`assets/indexes/${assetIndex.id}.json`],
      });
      noteDownload(result.source, result.size);
      assetIndexJson = await opfs.readJson<AssetIndexJson>(indexPath);

      const objects = Object.entries(assetIndexJson.objects).map(([logicalPath, object]) => ({
        logicalPath,
        hash: object.hash ?? object.sha1 ?? "",
        size: object.size,
      }));
      const invalid = objects.find((object) => !object.hash);
      if (invalid) throw new Error(`El asset index contiene un objeto sin hash: ${invalid.logicalPath}`);

      let assetsDone = 0;
      let assetBytesDone = 0;
      const assetBytesTotal = objects.reduce((sum, object) => sum + object.size, 0);
      await runPool(objects, concurrency, async (object) => {
        const relative = assetObjectRelativePath(object.hash);
        const objectPath = `${CACHE_ROOT}/assets/objects/${relative}`;
        const ensureResult = await downloader.ensureFile({
          label: `asset ${object.logicalPath}`,
          opfsPath: objectPath,
          url: `${RESOURCES_BASE}${relative}`,
          sha1: object.hash,
          size: object.size,
          localCandidates: [`assets/objects/${relative}`],
          verifyExisting: false,
        });
        noteDownload(ensureResult.source, ensureResult.size);

        if (assetIndexJson?.virtual || assetIndexJson?.map_to_resources) {
          const virtualPath = `${CACHE_ROOT}/assets/virtual/${assetIndex.id}/${object.logicalPath}`;
          const virtualStat = await opfs.stat(virtualPath);
          if (!virtualStat || virtualStat.size !== object.size) {
            const file = await opfs.readFile(objectPath);
            await opfs.writeFile(virtualPath, file);
          }
        }

        assetsDone += 1;
        assetBytesDone += object.size;
        if (assetsDone % 25 === 0 || assetsDone === objects.length) {
          options.onProgress?.({
            phase: "Descargando assets",
            done: assetsDone,
            total: objects.length,
            current: object.logicalPath,
            bytesDone: assetBytesDone,
            bytesTotal: assetBytesTotal,
          });
        }
      });

      if (assetIndexJson.map_to_resources) {
        stageAssetsToResourcesFromOpfs = `${CACHE_ROOT}/assets/virtual/${assetIndex.id}`;
      } else if (assetIndexJson.virtual) {
        assetsDirOpfsPath = `${CACHE_ROOT}/assets/virtual/${assetIndex.id}`;
      }
      this.serviceOptions.log(`Assets ${assetIndex.id}: ${objects.length} objetos (${formatBytes(assetBytesTotal)}).`);
    } else {
      this.serviceOptions.log("El perfil no declara assetIndex; versiones muy antiguas pueden traer recursos dentro del JAR.", "warn");
    }

    // 4. Arguments and JVM properties.
    const gameDirJvmPath = `/files/web-prism/instances/${instance.id}/minecraft`;
    const assetsDirJvmPath = stageAssetsToResourcesFromOpfs ? `${gameDirJvmPath}/resources` : cheerpjAppPath(assetsDirOpfsPath);
    const uuid = offlineUuid(options.username);
    const context = webRuleContext(options.width > 0 && options.height > 0);
    const rawGameArgs = profile.arguments?.game.length
      ? expandArguments(profile.arguments.game, context)
      : profile.minecraftArguments
        ? tokenizeLegacyArguments(profile.minecraftArguments)
        : [];
    const rawJvmArgs = [...expandArguments(profile.arguments?.jvm, context), ...profile.extraJvmArgs];
    const classpath = classpathJvmPaths.join(":");

    const substitutions: Record<string, string> = {
      auth_player_name: options.username,
      auth_username: options.username,
      auth_uuid: uuid,
      auth_access_token: "0",
      auth_session: "offline",
      user_properties: "{}",
      user_type: "legacy",
      version_name: profile.id,
      version_type: profile.type,
      game_directory: gameDirJvmPath,
      game_assets: assetsDirJvmPath,
      assets_root: assetsDirJvmPath,
      assets_index_name: assetIndex?.id ?? "",
      resolution_width: String(options.width),
      resolution_height: String(options.height),
      classpath,
      natives_directory: "/app/lwjgl/libraries",
      launcher_name: "WebPrism",
      launcher_version: "0.1.0",
      path: `${gameDirJvmPath}/logs/latest.log`,
    };

    let gameArgs = substituteArguments(rawGameArgs, substitutions);
    const ignoredJvmArgs: string[] = [];
    const javaProperties: string[] = [];
    for (const arg of substituteArguments(rawJvmArgs, substitutions)) {
      if (arg.startsWith("-D") && arg.length > 2) javaProperties.push(arg.slice(2));
      else ignoredJvmArgs.push(arg);
    }

    for (const tweaker of profile.tweakers) {
      if (!hasArgPair(gameArgs, "--tweakClass", tweaker)) gameArgs.push("--tweakClass", tweaker);
    }

    // Only vanilla's modern entry point is guaranteed to understand the full
    // --username/--uuid argument set. LaunchWrapper and legacy
    // net.minecraft.client.Minecraft use their declared minecraftArguments
    // verbatim (for example 1.2.5's positional "${auth_player_name} ${auth_session}").
    const isVanillaModernMain = profile.mainClass === "net.minecraft.client.main.Main";
    if (isVanillaModernMain) {
      addArgPairIfMissing(gameArgs, "--username", options.username);
      addArgPairIfMissing(gameArgs, "--version", profile.id);
      addArgPairIfMissing(gameArgs, "--gameDir", gameDirJvmPath);
      addArgPairIfMissing(gameArgs, "--assetsDir", assetsDirJvmPath);
      if (assetIndex?.id) addArgPairIfMissing(gameArgs, "--assetIndex", assetIndex.id);
      addArgPairIfMissing(gameArgs, "--uuid", uuid);
      addArgPairIfMissing(gameArgs, "--accessToken", "0");
      addArgPairIfMissing(gameArgs, "--userType", "legacy");
      addArgPairIfMissing(gameArgs, "--versionType", profile.type);
      addArgPairIfMissing(gameArgs, "--width", String(options.width));
      addArgPairIfMissing(gameArgs, "--height", String(options.height));
    }

    const unresolved = gameArgs.filter((arg) => arg.includes("${"));
    if (unresolved.length) {
      this.serviceOptions.log(`Argumentos con placeholders no resueltos: ${unresolved.join(" ")}`, "warn");
    }

    const plan: LaunchPlan = {
      instanceId: instance.id,
      instanceName: instance.name,
      username: options.username,
      uuid,
      profile,
      compatibility,
      classpathJvmPaths,
      classpath,
      gameArgs,
      ignoredJvmArgs,
      javaProperties,
      gameDirJvmPath,
      assetsDirJvmPath,
      assetIndexId: assetIndex?.id ?? "",
      stageAssetsToResourcesFromOpfs,
      downloads,
      createdAt: new Date().toISOString(),
    };

    await opfs.writeJson(`plans/${instance.id}.json`, plan).catch(() => undefined);
    this.serviceOptions.log(
      `Plan listo: ${downloads.files} archivo(s), ${formatBytes(downloads.bytes)} (caché ${downloads.bySource.cache}, local ${downloads.bySource.local + downloads.bySource.opfs}, descargados ${downloads.bySource.download}).`,
      "ok",
    );
    return plan;
  }
}
