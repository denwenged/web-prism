import type { PrismPatchJson } from "./mojang";
import { opfs } from "./opfs";
import {
  createInstanceCfg,
  createPackProfile,
  describeComponent,
  packProfileMinecraftVersion,
  parseInstanceCfg,
  parsePackProfile,
  removePackComponents,
  serializeInstanceCfg,
  setPackProfileMinecraftVersion,
  slugifyInstanceId,
  upsertPackComponents,
} from "./prism";
import type {
  BackendId,
  InstanceSettings,
  InstanceSummary,
  PrismComponent,
  PrismPackProfile,
  PrismRequirement,
  WebPrismInstanceSidecar,
} from "./types";

export const INSTANCES_ROOT = "instances";
export const CACHE_ROOT = "cache";

export function instanceRoot(id: string): string {
  return `${INSTANCES_ROOT}/${id}`;
}

export function instanceGameRoot(id: string, gameDirName: "minecraft" | ".minecraft" = "minecraft"): string {
  return `${instanceRoot(id)}/${gameDirName}`;
}

function defaultSidecar(): WebPrismInstanceSidecar {
  return {
    formatVersion: 1,
    backend: "auto",
    windowWidth: 854,
    windowHeight: 480,
    createdAt: new Date().toISOString(),
  };
}

async function findGameDirName(id: string): Promise<"minecraft" | ".minecraft"> {
  if (await opfs.exists(`${instanceRoot(id)}/.minecraft`)) {
    if (!(await opfs.exists(`${instanceRoot(id)}/minecraft`))) return ".minecraft";
  }
  return "minecraft";
}

async function countDirFiles(path: string, extensions?: string[]): Promise<number> {
  const entries = await opfs.list(path);
  return entries.filter((entry) => {
    if (entry.kind !== "file") return false;
    if (!extensions) return true;
    const lower = entry.name.toLowerCase();
    const enabledName = lower.endsWith(".disabled") ? lower.slice(0, -".disabled".length) : lower;
    return extensions.some((extension) => enabledName.endsWith(extension));
  }).length;
}

async function countSaves(gameRoot: string): Promise<number> {
  const saves = await opfs.list(`${gameRoot}/saves`);
  return saves.filter((entry) => entry.kind === "directory").length;
}

async function countDataPacks(gameRoot: string): Promise<number> {
  let total = await countDirFiles(`${gameRoot}/datapacks`, [".zip"]);
  const saves = await opfs.list(`${gameRoot}/saves`);
  for (const save of saves) {
    if (save.kind !== "directory") continue;
    const dataPacksPath = `${gameRoot}/saves/${save.name}/datapacks`;
    total += await countDirFiles(dataPacksPath, [".zip"]);
    const entries = await opfs.list(dataPacksPath);
    total += entries.filter((entry) => entry.kind === "directory").length;
  }
  return total;
}

export async function loadInstance(id: string): Promise<InstanceSummary | null> {
  const cfgText = await opfs.readOptionalText(`${instanceRoot(id)}/instance.cfg`);
  if (cfgText === null) return null;

  const settings = parseInstanceCfg(cfgText);
  const packText = await opfs.readOptionalText(`${instanceRoot(id)}/mmc-pack.json`);
  let pack: PrismPackProfile | null = null;
  if (packText) {
    try {
      pack = parsePackProfile(packText);
    } catch {
      pack = null;
    }
  }

  const sidecar = (await opfs.readOptionalJson<WebPrismInstanceSidecar>(`${instanceRoot(id)}/webprism.json`)) ?? defaultSidecar();
  const gameDirName = await findGameDirName(id);
  const gameRoot = `${instanceRoot(id)}/${gameDirName}`;

  return {
    id,
    name: settings.name || id,
    iconKey: settings.iconKey || "default",
    notes: settings.notes || "",
    minecraftVersion: packProfileMinecraftVersion(pack),
    components: pack?.components ?? [],
    sidecar,
    gameDirName,
    modCount: await countDirFiles(`${gameRoot}/mods`, [".jar", ".zip", ".litemod", ".nilmod"]),
    resourcePackCount: await countDirFiles(`${gameRoot}/resourcepacks`, [".zip"]),
    shaderPackCount: await countDirFiles(`${gameRoot}/shaderpacks`, [".zip"]),
    dataPackCount: await countDataPacks(gameRoot),
    saveCount: await countSaves(gameRoot),
    lastLaunchTime: Number.parseInt(settings.lastLaunchTime ?? "0", 10) || 0,
    totalTimePlayed: Number.parseInt(settings.totalTimePlayed ?? "0", 10) || 0,
  };
}

export async function listInstances(): Promise<InstanceSummary[]> {
  await opfs.ensureDir(INSTANCES_ROOT);
  const entries = await opfs.list(INSTANCES_ROOT);
  const instances: InstanceSummary[] = [];
  for (const entry of entries) {
    if (entry.kind !== "directory") continue;
    const instance = await loadInstance(entry.name);
    if (instance) instances.push(instance);
  }
  instances.sort((a, b) => a.name.localeCompare(b.name));
  return instances;
}

export async function allocateInstanceId(preferredName: string): Promise<string> {
  const base = slugifyInstanceId(preferredName);
  let candidate = base;
  let suffix = 2;
  while (await opfs.exists(instanceRoot(candidate))) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

export interface CreateInstanceOptions {
  name: string;
  minecraftVersion: string;
  backend?: BackendId;
  id?: string;
}

export async function createInstance(options: CreateInstanceOptions): Promise<InstanceSummary> {
  const id = options.id ?? (await allocateInstanceId(options.name));
  const root = instanceRoot(id);

  await opfs.ensureDir(`${root}/minecraft/mods`);
  await opfs.ensureDir(`${root}/minecraft/saves`);
  await opfs.ensureDir(`${root}/minecraft/resourcepacks`);
  await opfs.ensureDir(`${root}/minecraft/shaderpacks`);
  await opfs.ensureDir(`${root}/minecraft/datapacks`);
  await opfs.ensureDir(`${root}/minecraft/texturepacks`);
  await opfs.ensureDir(`${root}/minecraft/config`);
  await opfs.ensureDir(`${root}/patches`);
  await opfs.writeText(`${root}/instance.cfg`, createInstanceCfg(options.name));
  await opfs.writeJson(`${root}/mmc-pack.json`, createPackProfile(options.minecraftVersion));
  const sidecar: WebPrismInstanceSidecar = { ...defaultSidecar(), backend: options.backend ?? "auto" };
  await opfs.writeJson(`${root}/webprism.json`, sidecar);

  const created = await loadInstance(id);
  if (!created) throw new Error("La instancia se escribió en OPFS pero no pudo leerse de vuelta.");
  return created;
}

export async function updateInstanceVersion(instance: InstanceSummary, minecraftVersion: string): Promise<InstanceSummary> {
  const root = instanceRoot(instance.id);
  const packText = await opfs.readOptionalText(`${root}/mmc-pack.json`);
  const pack = packText ? parsePackProfile(packText) : createPackProfile(minecraftVersion);
  await opfs.writeJson(`${root}/mmc-pack.json`, setPackProfileMinecraftVersion(pack, minecraftVersion));
  const updated = await loadInstance(instance.id);
  if (!updated) throw new Error("No se pudo recargar la instancia tras cambiar la versión.");
  return updated;
}

export interface ComponentInstallInput {
  uid: string;
  version: string;
  name?: string;
  patch: PrismPatchJson;
  dependencyOnly?: boolean;
  requires?: PrismRequirement[];
  conflicts?: PrismRequirement[];
}

export async function readInstancePackProfile(id: string): Promise<PrismPackProfile | null> {
  const text = await opfs.readOptionalText(`${instanceRoot(id)}/mmc-pack.json`);
  return text ? parsePackProfile(text) : null;
}

export async function writeInstancePatch(id: string, uid: string, patch: PrismPatchJson): Promise<void> {
  await opfs.writeJson(`${instanceRoot(id)}/patches/${uid}.json`, patch);
}

export async function installInstanceComponents(
  id: string,
  installs: ComponentInstallInput[],
  removeUids: Iterable<string> = [],
): Promise<InstanceSummary> {
  const root = instanceRoot(id);
  const current = await loadInstance(id);
  if (!current) throw new Error("La instancia no existe.");
  const pack = (await readInstancePackProfile(id)) ?? createPackProfile(current.minecraftVersion || "1.12.2");
  const additions: PrismComponent[] = installs.map((install) => ({
    uid: install.uid,
    version: install.version,
    cachedVersion: install.version,
    cachedName: install.name ?? install.patch.name ?? describeComponent(install.uid),
    cachedRequires: install.requires ?? install.patch.requires,
    cachedConflicts: install.conflicts ?? install.patch.conflicts,
    dependencyOnly: install.dependencyOnly ?? false,
    disabled: false,
  }));
  const remove = new Set(removeUids);
  await opfs.writeJson(`${root}/mmc-pack.json`, upsertPackComponents(pack, additions, remove));
  for (const install of installs) {
    await writeInstancePatch(id, install.uid, install.patch);
  }
  const installedUids = new Set(installs.map((install) => install.uid));
  for (const uid of remove) {
    if (!installedUids.has(uid)) await opfs.removeIfExists(`${root}/patches/${uid}.json`);
  }
  const updated = await loadInstance(id);
  if (!updated) throw new Error("No se pudo recargar la instancia tras instalar componentes.");
  return updated;
}

export async function removeInstanceComponents(id: string, uids: Iterable<string>, removePatchFiles = true): Promise<InstanceSummary> {
  const root = instanceRoot(id);
  const current = await loadInstance(id);
  if (!current) throw new Error("La instancia no existe.");
  const pack = (await readInstancePackProfile(id)) ?? createPackProfile(current.minecraftVersion || "1.12.2");
  const remove = new Set(uids);
  await opfs.writeJson(`${root}/mmc-pack.json`, removePackComponents(pack, remove));
  if (removePatchFiles) {
    for (const uid of remove) await opfs.removeIfExists(`${root}/patches/${uid}.json`);
  }
  const updated = await loadInstance(id);
  if (!updated) throw new Error("No se pudo recargar la instancia tras quitar componentes.");
  return updated;
}

export async function updateInstanceSidecar(id: string, patch: Partial<WebPrismInstanceSidecar>): Promise<InstanceSummary> {
  const current = (await opfs.readOptionalJson<WebPrismInstanceSidecar>(`${instanceRoot(id)}/webprism.json`)) ?? defaultSidecar();
  await opfs.writeJson(`${instanceRoot(id)}/webprism.json`, { ...current, ...patch, formatVersion: 1 });
  const updated = await loadInstance(id);
  if (!updated) throw new Error("No se pudo recargar la instancia tras actualizar WebPrism.");
  return updated;
}

export async function renameInstance(instance: InstanceSummary, newName: string): Promise<InstanceSummary> {
  const root = instanceRoot(instance.id);
  const settings = parseInstanceCfg((await opfs.readOptionalText(`${root}/instance.cfg`)) ?? "");
  const next: InstanceSettings = { ...settings, name: newName, InstanceType: settings.InstanceType || "OneSix" };
  await opfs.writeText(`${root}/instance.cfg`, serializeInstanceCfg(next));
  const updated = await loadInstance(instance.id);
  if (!updated) throw new Error("No se pudo recargar la instancia tras renombrarla.");
  return updated;
}

export async function deleteInstance(id: string): Promise<void> {
  await opfs.remove(instanceRoot(id));
}

export async function touchInstanceLaunchTimes(id: string, startedAt: number, endedAt: number): Promise<void> {
  const root = instanceRoot(id);
  const text = await opfs.readOptionalText(`${root}/instance.cfg`);
  if (!text) return;
  const settings = parseInstanceCfg(text);
  const playedSeconds = Math.max(0, Math.round((endedAt - startedAt) / 1000));
  const previousTotal = Number.parseInt(settings.totalTimePlayed ?? "0", 10) || 0;
  settings.lastLaunchTime = String(startedAt);
  settings.lastTimePlayed = String(playedSeconds);
  settings.totalTimePlayed = String(previousTotal + playedSeconds);
  await opfs.writeText(`${root}/instance.cfg`, serializeInstanceCfg(settings));
}
