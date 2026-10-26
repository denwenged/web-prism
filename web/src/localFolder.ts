import { handleStore } from "./idb";
import { opfs } from "./opfs";
import { allocateInstanceId, instanceRoot } from "./instances";
import { createInstanceCfg, createPackProfile, parseInstanceCfg, parsePackProfile, slugifyInstanceId } from "./prism";
import type { LogListener, ProgressListener } from "./types";

export const SHARED_CACHE_HANDLE_KEY = "shared-cache-dir";
export const instanceHandleKey = (instanceId: string) => `instance-dir:${instanceId}`;

export function supportsDirectoryPicker(): boolean {
  return typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";
}

export async function pickDirectory(mode: "read" | "readwrite" = "read"): Promise<FileSystemDirectoryHandle> {
  if (!window.showDirectoryPicker) {
    throw new Error("Tu navegador no soporta File System Access API. La selección de carpetas locales requiere Chromium, Chrome o Edge.");
  }
  return window.showDirectoryPicker({ mode });
}

export async function ensureHandlePermission(handle: FileSystemHandle, mode: "read" | "readwrite", request = true): Promise<boolean> {
  const descriptor = { mode };
  if (!handle.queryPermission) return true;
  if ((await handle.queryPermission(descriptor)) === "granted") return true;
  if (!request || !handle.requestPermission) return false;
  return (await handle.requestPermission(descriptor)) === "granted";
}

function splitPath(path: string): string[] {
  return path.split("/").filter(Boolean);
}

export async function localChildDir(
  root: FileSystemDirectoryHandle,
  path: string,
  options: { create?: boolean } = {},
): Promise<FileSystemDirectoryHandle | null> {
  let current = root;
  for (const segment of splitPath(path)) {
    try {
      current = await current.getDirectoryHandle(segment, { create: options.create ?? false });
    } catch {
      return null;
    }
  }
  return current;
}

export async function localChildFile(
  root: FileSystemDirectoryHandle,
  path: string,
  options: { create?: boolean } = {},
): Promise<FileSystemFileHandle | null> {
  const segments = splitPath(path);
  if (!segments.length) return null;
  const dir = await localChildDir(root, segments.slice(0, -1).join("/"), options);
  if (!dir) return null;
  try {
    return await dir.getFileHandle(segments[segments.length - 1], { create: options.create ?? false });
  } catch {
    return null;
  }
}

export async function localReadFile(root: FileSystemDirectoryHandle, path: string): Promise<File | null> {
  const handle = await localChildFile(root, path);
  return handle ? handle.getFile() : null;
}

export async function localReadText(root: FileSystemDirectoryHandle, path: string): Promise<string | null> {
  const file = await localReadFile(root, path);
  return file ? file.text() : null;
}

export async function localExists(root: FileSystemDirectoryHandle, path: string): Promise<boolean> {
  return (await localChildFile(root, path)) !== null || (await localChildDir(root, path)) !== null;
}

export async function localList(root: FileSystemDirectoryHandle, path = ""): Promise<FileSystemHandle[]> {
  const dir = path ? await localChildDir(root, path) : root;
  if (!dir) return [];
  const out: FileSystemHandle[] = [];
  for await (const handle of dir.values()) out.push(handle);
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export async function localWriteFile(root: FileSystemDirectoryHandle, path: string, data: Blob | string): Promise<void> {
  const handle = await localChildFile(root, path, { create: true });
  if (!handle) throw new Error(`No se pudo crear el archivo local ${path}`);
  const writable = await (handle as FileSystemFileHandle & { createWritable(): Promise<FileSystemWritableFileStream> }).createWritable();
  try {
    await writable.write(data);
  } finally {
    await writable.close();
  }
}

export type LocalFolderKind = "prism-instance" | "prism-instances-root" | "minecraft" | "shared-cache" | "unknown";

export interface LocalFolderDetection {
  kind: LocalFolderKind;
  name: string;
  versionIds: string[];
  instanceNames: string[];
  saveNames: string[];
  modCount: number;
  summary: string;
}

async function shallowDirNames(root: FileSystemDirectoryHandle, path: string, limit = 200): Promise<string[]> {
  const entries = await localList(root, path);
  return entries.filter((entry) => entry.kind === "directory").slice(0, limit).map((entry) => entry.name);
}

async function shallowFileCount(root: FileSystemDirectoryHandle, path: string, extensions: string[]): Promise<number> {
  const entries = await localList(root, path);
  return entries.filter((entry) => entry.kind === "file" && extensions.some((extension) => entry.name.toLowerCase().endsWith(extension))).length;
}

export async function detectLocalFolder(root: FileSystemDirectoryHandle): Promise<LocalFolderDetection> {
  const isPrismInstance = await localExists(root, "instance.cfg");
  const childDirs = await localList(root);
  const candidateInstances: string[] = [];
  for (const child of childDirs) {
    if (child.kind !== "directory") continue;
    const childDir = child as FileSystemDirectoryHandle;
    if (await localExists(childDir, "instance.cfg")) candidateInstances.push(child.name);
    if (candidateInstances.length >= 50) break;
  }

  const versionIds = await shallowDirNames(root, "versions");
  const hasLibraries = await localExists(root, "libraries");
  const hasAssets = await localExists(root, "assets");
  const gameRootPath = isPrismInstance ? ((await localExists(root, "minecraft")) ? "minecraft" : ".minecraft") : "";
  const saveNames = await shallowDirNames(root, gameRootPath ? `${gameRootPath}/saves` : "saves", 100);
  const modCount = await shallowFileCount(root, gameRootPath ? `${gameRootPath}/mods` : "mods", [".jar", ".zip", ".litemod"]);

  if (isPrismInstance) {
    return {
      kind: "prism-instance",
      name: root.name,
      versionIds,
      instanceNames: [root.name],
      saveNames,
      modCount,
      summary: `Instancia Prism: ${saveNames.length} mundo(s), ${modCount} mod(s) en la carpeta raíz de mods.`,
    };
  }

  if (candidateInstances.length > 0) {
    return {
      kind: "prism-instances-root",
      name: root.name,
      versionIds,
      instanceNames: candidateInstances,
      saveNames,
      modCount,
      summary: `Carpeta de instancias Prism con ${candidateInstances.length} instancia(s): ${candidateInstances.slice(0, 5).join(", ")}${candidateInstances.length > 5 ? "…" : ""}.`,
    };
  }

  if (versionIds.length > 0 && (hasLibraries || hasAssets)) {
    return {
      kind: root.name === ".minecraft" || saveNames.length > 0 || modCount > 0 ? "minecraft" : "shared-cache",
      name: root.name,
      versionIds,
      instanceNames: [],
      saveNames,
      modCount,
      summary: `Instalación .minecraft/caché compartida: ${versionIds.length} versión(es), ${saveNames.length} mundo(s), ${modCount} mod(s).`,
    };
  }

  return {
    kind: "unknown",
    name: root.name,
    versionIds,
    instanceNames: [],
    saveNames,
    modCount,
    summary: "No se reconoció ni una instancia Prism (instance.cfg) ni una carpeta .minecraft (versions + libraries/assets).",
  };
}

const SKIP_DIR_NAMES = new Set(["logs", "crash-reports", ".git", "cache", "webcache", "debug"]);
const SKIP_FILE_SUFFIXES = [".log", ".lck"];

interface CopyStats {
  files: number;
  bytes: number;
}

async function copyLocalToOpfs(
  localDir: FileSystemDirectoryHandle,
  localBasePath: string,
  opfsBasePath: string,
  stats: CopyStats,
  onProgress?: ProgressListener,
  label = "Importando carpeta local",
): Promise<void> {
  const visit = async (relative: string): Promise<void> => {
    const localPath = relative ? `${localBasePath}/${relative}` : localBasePath;
    for (const entry of await localList(localDir, localPath)) {
      const nextRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.kind === "directory") {
        if (SKIP_DIR_NAMES.has(entry.name)) continue;
        await opfs.ensureDir(`${opfsBasePath}/${nextRelative}`);
        await visit(nextRelative);
      } else {
        if (SKIP_FILE_SUFFIXES.some((suffix) => entry.name.toLowerCase().endsWith(suffix))) continue;
        const file = await (entry as FileSystemFileHandle).getFile();
        await opfs.writeFile(`${opfsBasePath}/${nextRelative}`, file);
        stats.files += 1;
        stats.bytes += file.size;
        onProgress?.({ phase: label, done: stats.files, total: Math.max(stats.files, 1), current: nextRelative, bytesDone: stats.bytes });
      }
    }
  };
  await visit("");
}

async function countLocalFiles(localDir: FileSystemDirectoryHandle, localBasePath: string): Promise<CopyStats> {
  const stats: CopyStats = { files: 0, bytes: 0 };
  const visit = async (relative: string): Promise<void> => {
    const localPath = relative ? `${localBasePath}/${relative}` : localBasePath;
    for (const entry of await localList(localDir, localPath)) {
      const nextRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.kind === "directory") {
        if (!SKIP_DIR_NAMES.has(entry.name)) await visit(nextRelative);
      } else if (!SKIP_FILE_SUFFIXES.some((suffix) => entry.name.toLowerCase().endsWith(suffix))) {
        const file = await (entry as FileSystemFileHandle).getFile();
        stats.files += 1;
        stats.bytes += file.size;
      }
    }
  };
  await visit("");
  return stats;
}

export async function importPrismInstance(
  dir: FileSystemDirectoryHandle,
  onProgress?: ProgressListener,
  onLog?: LogListener,
): Promise<string> {
  if (!(await ensureHandlePermission(dir, "read"))) throw new Error("Permiso de lectura denegado para la instancia local.");
  const cfgText = await localReadText(dir, "instance.cfg");
  if (!cfgText) throw new Error("La carpeta elegida no contiene instance.cfg; no es una instancia Prism.");
  const settings = parseInstanceCfg(cfgText);
  const displayName = settings.name || dir.name;
  const id = await allocateInstanceId(displayName || dir.name);
  const root = instanceRoot(id);

  onLog?.(`Importando instancia Prism «${displayName}» como ${id}…`);
  const stats: CopyStats = { files: 0, bytes: 0 };
  await opfs.ensureDir(`${root}/minecraft`);
  await opfs.writeText(`${root}/instance.cfg`, cfgText);

  const packText = await localReadText(dir, "mmc-pack.json");
  if (packText) {
    parsePackProfile(packText); // validate before copying lots of files
    await opfs.writeText(`${root}/mmc-pack.json`, packText);
  } else {
    await opfs.writeJson(`${root}/mmc-pack.json`, createPackProfile("1.12.2"));
    onLog?.("La instancia no tenía mmc-pack.json; se creó uno provisional. Revisa la versión antes de jugar.", "warn");
  }

  for (const extraDir of ["patches", "jarmods", "libraries"]) {
    if (await localExists(dir, extraDir)) {
      await copyLocalToOpfs(dir, extraDir, `${root}/${extraDir}`, stats, onProgress, `Importando ${extraDir}`);
    }
  }

  const gameDirName = (await localExists(dir, "minecraft")) ? "minecraft" : (await localExists(dir, ".minecraft")) ? ".minecraft" : null;
  if (gameDirName) {
    const expected = await countLocalFiles(dir, gameDirName);
    onProgress?.({ phase: "Importando carpeta de juego", done: 0, total: expected.files, bytesDone: 0, bytesTotal: expected.bytes });
    const beforeFiles = stats.files;
    const beforeBytes = stats.bytes;
    await copyLocalToOpfs(dir, gameDirName, `${root}/minecraft`, stats, (event) => {
      onProgress?.({
        ...event,
        total: expected.files,
        done: stats.files - beforeFiles,
        bytesDone: stats.bytes - beforeBytes,
        bytesTotal: expected.bytes,
      });
    }, "Importando carpeta de juego");
  }

  await opfs.writeJson(`${root}/webprism.json`, {
    formatVersion: 1,
    backend: "auto",
    windowWidth: 854,
    windowHeight: 480,
    createdAt: new Date().toISOString(),
    linkedLocalKind: "prism-instance",
    linkedLocalName: dir.name,
  });
  await handleStore.set(instanceHandleKey(id), dir);
  onLog?.(`Instancia importada: ${stats.files} archivo(s), ${(stats.bytes / 1024 / 1024).toFixed(1)} MiB.`, "ok");
  return id;
}

export async function importPrismInstancesRoot(
  root: FileSystemDirectoryHandle,
  onProgress?: ProgressListener,
  onLog?: LogListener,
): Promise<string[]> {
  const imported: string[] = [];
  for (const child of await localList(root)) {
    if (child.kind !== "directory") continue;
    const childDir = child as FileSystemDirectoryHandle;
    if (!(await localExists(childDir, "instance.cfg"))) continue;
    try {
      imported.push(await importPrismInstance(childDir, onProgress, onLog));
    } catch (error) {
      onLog?.(`No se pudo importar ${child.name}: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }
  return imported;
}

const MINECRAFT_USER_DIRS = ["saves", "mods", "coremods", "config", "resourcepacks", "texturepacks", "shaderpacks", "datapacks", "scripts", "screenshots"];
const MINECRAFT_USER_FILES = ["options.txt", "optionsof.txt", "optionsshaders.txt", "servers.dat", "servers.dat_old", "usercache.json", "usernamecache.json", "hotbar.nbt"];

export async function importMinecraftFolderAsInstance(
  dir: FileSystemDirectoryHandle,
  minecraftVersion: string,
  onProgress?: ProgressListener,
  onLog?: LogListener,
): Promise<string> {
  if (!(await ensureHandlePermission(dir, "read"))) throw new Error("Permiso de lectura denegado para la carpeta .minecraft.");
  const detection = await detectLocalFolder(dir);
  const displayName = dir.name === ".minecraft" ? "Minecraft local" : `${dir.name} (local)`;
  const id = await allocateInstanceId(displayName);
  const root = instanceRoot(id);
  const stats: CopyStats = { files: 0, bytes: 0 };

  onLog?.(`Creando instancia desde ${dir.name}: ${detection.summary}`);
  await opfs.ensureDir(`${root}/minecraft`);
  await opfs.writeText(`${root}/instance.cfg`, createInstanceCfg(displayName));
  await opfs.writeJson(`${root}/mmc-pack.json`, createPackProfile(minecraftVersion));

  for (const userDir of MINECRAFT_USER_DIRS) {
    if (await localExists(dir, userDir)) {
      const expected = await countLocalFiles(dir, userDir);
      const beforeFiles = stats.files;
      const beforeBytes = stats.bytes;
      await copyLocalToOpfs(dir, userDir, `${root}/minecraft/${userDir}`, stats, (event) => {
        onProgress?.({
          ...event,
          phase: `Importando ${userDir}`,
          total: expected.files,
          done: stats.files - beforeFiles,
          bytesDone: stats.bytes - beforeBytes,
          bytesTotal: expected.bytes,
        });
      }, `Importando ${userDir}`);
    }
  }
  for (const userFile of MINECRAFT_USER_FILES) {
    const file = await localReadFile(dir, userFile);
    if (file) await opfs.writeFile(`${root}/minecraft/${userFile}`, file);
  }

  // Version JSONs are small and make custom Forge/Fabric profiles resolvable
  // even after the directory permission is gone. JARs stay on demand.
  for (const versionId of detection.versionIds.slice(0, 100)) {
    const safeVersionId = slugifyInstanceId(versionId);
    const json = await localReadFile(dir, `versions/${versionId}/${versionId}.json`);
    if (json) await opfs.writeFile(`cache/versions/${safeVersionId}/${safeVersionId}.json`, json);
  }

  await opfs.writeJson(`${root}/webprism.json`, {
    formatVersion: 1,
    backend: "auto",
    windowWidth: 854,
    windowHeight: 480,
    createdAt: new Date().toISOString(),
    linkedLocalKind: "minecraft",
    linkedLocalName: dir.name,
  });
  await handleStore.set(instanceHandleKey(id), dir);
  await handleStore.set(SHARED_CACHE_HANDLE_KEY, dir);
  onLog?.(`Instancia local creada con ${stats.files} archivo(s) de usuario. La caché versions/libraries/assets se leerá bajo demanda.`, "ok");
  return id;
}

export async function linkSharedCache(dir: FileSystemDirectoryHandle): Promise<LocalFolderDetection> {
  if (!(await ensureHandlePermission(dir, "read"))) throw new Error("Permiso de lectura denegado para la caché local.");
  const detection = await detectLocalFolder(dir);
  await handleStore.set(SHARED_CACHE_HANDLE_KEY, dir);
  return detection;
}

export async function getSharedCacheDir(requestPermission = true): Promise<FileSystemDirectoryHandle | null> {
  const handle = await handleStore.get<FileSystemDirectoryHandle>(SHARED_CACHE_HANDLE_KEY);
  if (!handle || handle.kind !== "directory") return null;
  return (await ensureHandlePermission(handle, "read", requestPermission)) ? handle : null;
}

export async function getInstanceDirHandle(instanceId: string, mode: "read" | "readwrite", requestPermission = true): Promise<FileSystemDirectoryHandle | null> {
  const handle = await handleStore.get<FileSystemDirectoryHandle>(instanceHandleKey(instanceId));
  if (!handle || handle.kind !== "directory") return null;
  return (await ensureHandlePermission(handle, mode, requestPermission)) ? handle : null;
}

/** Implements the downloader's LocalFileSource interface without a circular import. */
export async function readFromSharedCache(candidates: string[]): Promise<File | null> {
  const dir = await getSharedCacheDir(true);
  if (!dir) return null;
  for (const candidate of candidates) {
    const file = await localReadFile(dir, candidate);
    if (file) return file;
  }
  return null;
}

export async function exportMinecraftGameDirToLocal(
  instanceId: string,
  gameDirName: "minecraft" | ".minecraft",
  target: FileSystemDirectoryHandle,
  onProgress?: ProgressListener,
  onLog?: LogListener,
): Promise<void> {
  if (!(await ensureHandlePermission(target, "readwrite"))) throw new Error("Permiso de escritura denegado para la carpeta .minecraft destino.");
  const gameRoot = `${instanceRoot(instanceId)}/${gameDirName}`;
  const files = await opfs.walk(gameRoot);
  let done = 0;
  let bytes = 0;

  for (const filePath of files) {
    const relative = filePath.slice(gameRoot.length + 1);
    const file = await opfs.readFile(filePath);
    await localWriteFile(target, relative, file);
    done += 1;
    bytes += file.size;
    onProgress?.({ phase: "Sincronizando .minecraft local", done, total: files.length, current: relative, bytesDone: bytes });
  }

  await handleStore.set(instanceHandleKey(instanceId), target);
  await handleStore.set(SHARED_CACHE_HANDLE_KEY, target);
  onLog?.(`Carpeta de juego sincronizada a «${target.name}»: ${done} archivo(s) de saves/mods/config.`, "ok");
}

export async function exportInstanceToLocal(
  instanceId: string,
  target: FileSystemDirectoryHandle,
  onProgress?: ProgressListener,
  onLog?: LogListener,
): Promise<void> {
  if (!(await ensureHandlePermission(target, "readwrite"))) throw new Error("Permiso de escritura denegado para la carpeta destino.");
  const root = instanceRoot(instanceId);
  const files = await opfs.walk(root);
  let done = 0;
  let bytes = 0;

  for (const filePath of files) {
    const relative = filePath.slice(root.length + 1);
    if (relative === "webprism.json") continue;
    const file = await opfs.readFile(filePath);
    await localWriteFile(target, relative, file);
    done += 1;
    bytes += file.size;
    onProgress?.({ phase: "Exportando a la carpeta local", done, total: files.length, current: relative, bytesDone: bytes });
  }

  await handleStore.set(instanceHandleKey(instanceId), target);
  onLog?.(`Instancia exportada a «${target.name}»: ${done} archivo(s). Prism de escritorio debería reconocerla si está dentro de su carpeta de instancias.`, "ok");
}
