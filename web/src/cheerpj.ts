import type { LaunchPlan } from "./launcherService";
import { instanceGameRoot } from "./instances";
import { cheerpjAppPath, opfs } from "./opfs";
import type { InstanceSummary, LogListener, ProgressListener } from "./types";

interface CheerpJInitOptions {
  version?: number;
  status?: "splash" | "none" | "default";
  javaProperties?: string[];
  libraries?: Record<string, string>;
  enableX11?: boolean;
  clipboardMode?: "permission" | "system" | "java";
  enableDebug?: boolean;
  [key: string]: unknown;
}

interface CheerpJApi {
  cheerpjInit(options?: CheerpJInitOptions): Promise<void>;
  cheerpjCreateDisplay(width: number, height: number, element?: HTMLElement): Promise<unknown> | unknown;
  cheerpjRunMain(className: string, classPath: string, ...args: string[]): Promise<number>;
  cheerpjRunLibrary(classPath: string): Promise<any>;
  cjFileBlob(path: string): Promise<Blob>;
}

function api(): CheerpJApi {
  const candidate = globalThis as unknown as Partial<CheerpJApi>;
  if (typeof candidate.cheerpjInit !== "function") {
    throw new Error("CheerpJ no expuso cheerpjInit. ¿Se cargó correctamente loader.js?");
  }
  return candidate as CheerpJApi;
}

let loaderPromise: Promise<void> | null = null;
let initializedJavaVersion: number | null = null;
let displayCreatedFor: HTMLElement | null = null;
let gameRunning = false;

export function isGameRunning(): boolean {
  return gameRunning;
}

export function loadCheerpjLoader(loaderUrl: string): Promise<void> {
  if (typeof (globalThis as Partial<CheerpJApi>).cheerpjInit === "function") return Promise.resolve();
  if (loaderPromise) return loaderPromise;

  loaderPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = loaderUrl;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`No se pudo cargar CheerpJ desde ${loaderUrl}`));
    document.head.appendChild(script);
  });
  return loaderPromise;
}

async function urlLooksAvailable(path: string): Promise<boolean> {
  try {
    const response = await fetch(path, { headers: { Range: "bytes=0-0" } });
    return response.ok || response.status === 206;
  } catch {
    return false;
  }
}

export async function checkLwjgl2Runtime(): Promise<{ ok: boolean; missing: string[] }> {
  const required = [
    "/lwjgl/lwjgl-2.9.3.jar",
    "/lwjgl/lwjgl_util-2.9.3.jar",
    "/lwjgl/libraries/gl4es.wasm",
    "/lwjgl/libraries/liblwjgl.so",
    "/lwjgl/libraries/lwjgl.js",
  ];
  const missing: string[] = [];
  for (const path of required) {
    if (!(await urlLooksAvailable(path))) missing.push(path);
  }
  return { ok: missing.length === 0, missing };
}

function dedupeJavaProperties(properties: string[]): string[] {
  const byKey = new Map<string, string>();
  for (const property of properties) {
    const equals = property.indexOf("=");
    const key = equals === -1 ? property : property.slice(0, equals);
    if (key) byKey.set(key, property);
  }
  return [...byKey.values()];
}

interface JavaFilesApi {
  Files: any;
  Paths: any;
  replaceExisting: any;
}

let javaFilesApi: JavaFilesApi | null = null;

async function getJavaFilesApi(): Promise<JavaFilesApi> {
  if (javaFilesApi) return javaFilesApi;
  const lib = await api().cheerpjRunLibrary("");
  const Files = await lib.java.nio.file.Files;
  const Paths = await lib.java.nio.file.Paths;
  const StandardCopyOption = await lib.java.nio.file.StandardCopyOption;
  const replaceExisting = await StandardCopyOption.REPLACE_EXISTING;
  javaFilesApi = { Files, Paths, replaceExisting };
  return javaFilesApi;
}

async function jvmPathObject(Paths: any, path: string): Promise<any> {
  return Paths.get(path);
}

async function jvmExists(Files: any, Paths: any, path: string): Promise<boolean> {
  try {
    return Boolean(await Files.exists(await jvmPathObject(Paths, path), []));
  } catch {
    return false;
  }
}

async function jvmSize(Files: any, Paths: any, path: string): Promise<number | null> {
  try {
    const value = await Files.size(await jvmPathObject(Paths, path));
    return Number(value);
  } catch {
    return null;
  }
}

async function jvmCreateDirectories(Files: any, Paths: any, path: string, cache: Set<string>): Promise<void> {
  if (!path || cache.has(path)) return;
  await Files.createDirectories(await jvmPathObject(Paths, path), []);
  cache.add(path);
}

function parentPath(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

async function stageOpfsDirectory(
  opfsBasePath: string,
  jvmBasePath: string,
  options: {
    lastSyncAt?: number;
    overwriteDifferentSize?: boolean;
    onProgress?: ProgressListener;
    phase: string;
  },
): Promise<number> {
  const { Files, Paths, replaceExisting } = await getJavaFilesApi();
  const files = await opfs.walk(opfsBasePath);
  const dirCache = new Set<string>();
  let copied = 0;

  await jvmCreateDirectories(Files, Paths, jvmBasePath, dirCache);

  for (let index = 0; index < files.length; index += 1) {
    const opfsPath = files[index];
    const relative = opfsPath.slice(opfsBasePath.length + 1);
    const targetPath = `${jvmBasePath}/${relative}`;
    const stat = await opfs.stat(opfsPath);
    const exists = await jvmExists(Files, Paths, targetPath);

    if (exists && stat) {
      const existingSize = await jvmSize(Files, Paths, targetPath);
      if (existingSize === stat.size) {
        options.onProgress?.({ phase: options.phase, done: index + 1, total: files.length, current: relative });
        continue;
      }
      const opfsLooksNewer = options.overwriteDifferentSize || (options.lastSyncAt !== undefined && stat.lastModified > options.lastSyncAt);
      if (!opfsLooksNewer) {
        options.onProgress?.({ phase: options.phase, done: index + 1, total: files.length, current: relative });
        continue;
      }
    }

    await jvmCreateDirectories(Files, Paths, parentPath(targetPath), dirCache);
    const source = await jvmPathObject(Paths, cheerpjAppPath(opfsPath));
    const target = await jvmPathObject(Paths, targetPath);
    await Files.copy(source, target, [replaceExisting]);
    copied += 1;
    options.onProgress?.({ phase: options.phase, done: index + 1, total: files.length, current: relative });
  }

  return copied;
}

async function listJvmFiles(rootPath: string): Promise<string[]> {
  const { Files, Paths } = await getJavaFilesApi();
  const root = await jvmPathObject(Paths, rootPath);
  if (!(await Files.exists(root, []))) return [];

  const stream = await Files.walk(root, []);
  try {
    const array = await stream.toArray();
    const out: string[] = [];
    for (let i = 0; i < array.length; i += 1) {
      const pathObject = array[i];
      const isDirectory = await Files.isDirectory(pathObject, []);
      if (!isDirectory) out.push(String(await pathObject.toString()));
    }
    return out;
  } finally {
    try {
      await stream.close();
    } catch {
      // The stream may already be closed by toArray on some runtimes.
    }
  }
}

export async function syncJvmGameDirToOpfs(
  instance: InstanceSummary,
  gameDirJvmPath: string,
  onProgress?: ProgressListener,
): Promise<number> {
  const { Files, Paths } = await getJavaFilesApi();
  const files = await listJvmFiles(gameDirJvmPath);
  const opfsBase = instanceGameRoot(instance.id, instance.gameDirName);
  let copied = 0;

  for (let index = 0; index < files.length; index += 1) {
    const jvmPath = files[index];
    const relative = jvmPath.slice(gameDirJvmPath.length).replace(/^\/+/, "");
    if (!relative || relative.startsWith("../")) continue;
    const opfsPath = `${opfsBase}/${relative}`;
    const jvmFileSize = await jvmSize(Files, Paths, jvmPath);
    const existing = await opfs.stat(opfsPath);
    if (existing && jvmFileSize !== null && existing.size === jvmFileSize) {
      onProgress?.({ phase: "Sincronizando partida", done: index + 1, total: files.length, current: relative });
      continue;
    }
    const blob = await api().cjFileBlob(jvmPath);
    await opfs.writeFile(opfsPath, blob);
    copied += 1;
    onProgress?.({ phase: "Sincronizando partida", done: index + 1, total: files.length, current: relative });
  }

  return copied;
}

async function seedOptionsIfMissing(instance: InstanceSummary): Promise<void> {
  const gameRoot = instanceGameRoot(instance.id, instance.gameDirName);
  if (await opfs.fileExists(`${gameRoot}/options.txt`)) return;
  // Conservative defaults for a single-threaded wasm JVM. Existing options are never touched.
  await opfs.writeText(
    `${gameRoot}/options.txt`,
    [
      "lang:es_es",
      "renderDistance:4",
      "maxFps:30",
      "enableVsync:false",
      "fboEnable:false",
      "useVbo:false",
      "particles:2",
      "mipmapLevels:0",
      "graphicsMode:0",
      "renderClouds:false",
      "entityShadows:false",
      "ao:0",
      "gamma:1.0",
      "guiScale:2",
      "mouseSensitivity:0.5",
      "",
    ].join("\n"),
  );
}

function dirtyKey(instanceId: string): string {
  return `webprism:jvm-dirty:${instanceId}`;
}

export interface RunCheerpjOptions {
  loaderUrl: string;
  display: HTMLElement;
  onLog: LogListener;
  onProgress?: ProgressListener;
  onJvmSyncComplete?: (timestamp: number) => Promise<void> | void;
}

export async function runCheerpjPlan(instance: InstanceSummary, plan: LaunchPlan, options: RunCheerpjOptions): Promise<number> {
  if (gameRunning) throw new Error("Ya hay un juego en marcha en esta pestaña. Ciérralo o recarga la página.");
  if (plan.compatibility.status === "blocked") {
    throw new Error(`Este perfil está bloqueado en el backend JVM: ${plan.compatibility.blockers.join(" ")}`);
  }
  const javaRuntime = plan.compatibility.javaRuntime;
  if (!javaRuntime) throw new Error("No hay runtime CheerpJ compatible para la versión de Java requerida.");

  if (plan.compatibility.hasLwjgl2) {
    const runtime = await checkLwjgl2Runtime();
    if (!runtime.ok) {
      throw new Error(`Falta el runtime LWJGL2 wasm (${runtime.missing.join(", ")}). En el servidor de despliegue ejecuta: npm run setup:runtime`);
    }
  }

  if (initializedJavaVersion !== null && initializedJavaVersion !== javaRuntime) {
    throw new Error(`CheerpJ ya se inicializó con Java ${initializedJavaVersion} en esta pestaña. Recarga la página para usar Java ${javaRuntime}.`);
  }

  options.onLog(`Cargando CheerpJ (Java ${javaRuntime})…`);
  await loadCheerpjLoader(options.loaderUrl);
  const cheerpj = api();

  if (initializedJavaVersion === null) {
    const javaProperties = dedupeJavaProperties([
      ...plan.javaProperties,
      "java.library.path=/app/lwjgl/libraries/",
      "org.lwjgl.librarypath=/app/lwjgl/libraries/",
      "minecraft.launcher.brand=WebPrism",
      "minecraft.launcher.version=0.1.0",
      `webprism.gameDir=${plan.gameDirJvmPath}`,
      `user.home=/files/web-prism/instances/${instance.id}`,
    ]);
    await cheerpj.cheerpjInit({
      version: javaRuntime,
      status: "default",
      clipboardMode: "permission",
      javaProperties,
      ...(plan.compatibility.hasLwjgl2
        ? {
            libraries: { "libGL.so.1": "/app/lwjgl/libraries/gl4es.wasm" },
            enableX11: true,
          }
        : {}),
    });
    initializedJavaVersion = javaRuntime;
    options.onLog(`CheerpJ listo: JVM Java ${javaRuntime} en WebAssembly.`, "ok");
  }

  if (displayCreatedFor !== options.display) {
    await cheerpj.cheerpjCreateDisplay(-1, -1, options.display);
    displayCreatedFor = options.display;
  }

  // If a previous page was closed mid-game, rescue its files before staging ours.
  if (localStorage.getItem(dirtyKey(instance.id)) === "1") {
    try {
      options.onLog("Se detectó una sesión JVM anterior sin sincronizar; recuperando /files → OPFS…", "warn");
      const rescued = await syncJvmGameDirToOpfs(instance, plan.gameDirJvmPath, options.onProgress);
      options.onLog(`Recuperación completada (${rescued} archivo(s) copiado(s)).`);
      localStorage.removeItem(dirtyKey(instance.id));
      await options.onJvmSyncComplete?.(Date.now());
    } catch (error) {
      options.onLog(`No se pudo recuperar la sesión anterior: ${error instanceof Error ? error.message : String(error)}`, "warn");
    }
  }

  await seedOptionsIfMissing(instance);

  if (plan.stageAssetsToResourcesFromOpfs) {
    const copied = await stageOpfsDirectory(plan.stageAssetsToResourcesFromOpfs, `${plan.gameDirJvmPath}/resources`, {
      phase: "Preparando resources legacy",
      onProgress: options.onProgress,
    });
    options.onLog(`Resources legacy preparados en la JVM (${copied} archivo(s) nuevo(s)).`);
  }

  const gameRoot = instanceGameRoot(instance.id, instance.gameDirName);
  const staged = await stageOpfsDirectory(gameRoot, plan.gameDirJvmPath, {
    phase: "Sincronizando instancia a la JVM",
    lastSyncAt: instance.sidecar.lastJvmSyncAt,
    onProgress: options.onProgress,
  });
  options.onLog(`Instancia sincronizada a CheerpJ /files (${staged} archivo(s) copiado(s)).`);

  options.onLog(`java ${plan.profile.mainClass} ${plan.gameArgs.join(" ")}`);
  if (plan.ignoredJvmArgs.length) {
    options.onLog(`Argumentos JVM ignorados por CheerpJ: ${plan.ignoredJvmArgs.join(" ")}`, "warn");
  }

  localStorage.setItem(dirtyKey(instance.id), "1");
  gameRunning = true;
  try {
    const exitCode = await cheerpj.cheerpjRunMain(plan.profile.mainClass, plan.classpath, ...plan.gameArgs);
    options.onLog(`La JVM terminó con código ${exitCode}.`, exitCode === 0 ? "ok" : "warn");
    return exitCode;
  } finally {
    gameRunning = false;
    try {
      const copiedBack = await syncJvmGameDirToOpfs(instance, plan.gameDirJvmPath, options.onProgress);
      options.onLog(`Partida sincronizada JVM → OPFS (${copiedBack} archivo(s)). Ya puedes exportarla a tu carpeta local.`, "ok");
      localStorage.removeItem(dirtyKey(instance.id));
      await options.onJvmSyncComplete?.(Date.now());
    } catch (error) {
      options.onLog(`La sincronización final falló; se reintentará al próximo arranque: ${error instanceof Error ? error.message : String(error)}`, "warn");
    }
  }
}
