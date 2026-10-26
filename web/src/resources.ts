import { instanceGameRoot } from "./instances";
import { opfs } from "./opfs";
import type { InstanceSummary } from "./types";

export type ResourceKind = "mods" | "resourcepacks" | "shaderpacks" | "datapacks";

export interface ResourceDefinition {
  kind: ResourceKind;
  label: string;
  singular: string;
  folderName: string;
  extensions: string[];
  accept: string;
  downloadLabel: string;
}

export const RESOURCE_DEFINITIONS: Record<ResourceKind, ResourceDefinition> = {
  mods: {
    kind: "mods",
    label: "Mods",
    singular: "mod",
    folderName: "mods",
    extensions: [".jar", ".zip", ".litemod", ".nilmod"],
    accept: ".jar,.zip,.litemod,.nilmod",
    downloadLabel: "Descargar mods",
  },
  resourcepacks: {
    kind: "resourcepacks",
    label: "Paquetes de recursos",
    singular: "paquete de recursos",
    folderName: "resourcepacks",
    extensions: [".zip"],
    accept: ".zip",
    downloadLabel: "Descargar paquetes",
  },
  shaderpacks: {
    kind: "shaderpacks",
    label: "Shaders",
    singular: "shader",
    folderName: "shaderpacks",
    extensions: [".zip"],
    accept: ".zip",
    downloadLabel: "Descargar shaders",
  },
  datapacks: {
    kind: "datapacks",
    label: "Paquetes de datos",
    singular: "paquete de datos",
    folderName: "datapacks",
    extensions: [".zip"],
    accept: ".zip",
    downloadLabel: "Descargar paquetes de datos",
  },
};

export interface ResourceTarget {
  id: string;
  label: string;
  opfsPath: string;
  displayPath: string;
  worldName?: string;
}

export interface InstalledResourceMetadata {
  provider: "modrinth" | "local";
  filename: string;
  targetId: string;
  kind: ResourceKind;
  installedAt: string;
  projectId?: string;
  projectSlug?: string;
  projectTitle?: string;
  versionId?: string;
  versionNumber?: string;
  sha1?: string;
  sha512?: string;
}

export interface InstalledResource {
  fileName: string;
  displayName: string;
  kind: ResourceKind;
  target: ResourceTarget;
  opfsPath: string;
  entryKind: "file" | "directory";
  enabled: boolean;
  size?: number;
  lastModified?: number;
  metadata?: InstalledResourceMetadata;
}

export function safeResourceFileName(raw: string): string {
  const fileName = raw.split(/[\\/]/).pop()?.trim() ?? "";
  if (!fileName || fileName === "." || fileName === ".." || fileName.includes("\0")) {
    throw new Error(`Nombre de archivo no válido: ${raw}`);
  }
  return fileName;
}

export function stripDisabledSuffix(fileName: string): string {
  return fileName.toLowerCase().endsWith(".disabled") ? fileName.slice(0, -".disabled".length) : fileName;
}

export function isResourceFileName(kind: ResourceKind, fileName: string): boolean {
  const normalized = stripDisabledSuffix(fileName).toLowerCase();
  return RESOURCE_DEFINITIONS[kind].extensions.some((extension) => normalized.endsWith(extension));
}

function gameRoot(instance: InstanceSummary): string {
  return instanceGameRoot(instance.id, instance.gameDirName);
}

export function resourceTargetPath(instance: InstanceSummary, relativePath: string): string {
  return `${gameRoot(instance)}/${relativePath}`;
}

export async function listResourceTargets(instance: InstanceSummary, kind: ResourceKind): Promise<ResourceTarget[]> {
  const definition = RESOURCE_DEFINITIONS[kind];
  const root = gameRoot(instance);
  if (kind !== "datapacks") {
    return [
      {
        id: "global",
        label: `${instance.gameDirName}/${definition.folderName}/`,
        opfsPath: `${root}/${definition.folderName}`,
        displayPath: `${instance.gameDirName}/${definition.folderName}/`,
      },
    ];
  }

  const targets: ResourceTarget[] = [
    {
      id: "global",
      label: "Carpeta global de Prism · minecraft/datapacks/",
      opfsPath: `${root}/datapacks`,
      displayPath: `${instance.gameDirName}/datapacks/`,
    },
  ];
  const saves = await opfs.list(`${root}/saves`);
  for (const save of saves) {
    if (save.kind !== "directory") continue;
    targets.push({
      id: `world:${save.name}`,
      label: `Mundo: ${save.name}`,
      opfsPath: `${root}/saves/${save.name}/datapacks`,
      displayPath: `${instance.gameDirName}/saves/${save.name}/datapacks/`,
      worldName: save.name,
    });
  }
  return targets;
}

function metadataPath(instance: InstanceSummary, kind: ResourceKind, target: ResourceTarget, fileName: string): string {
  return `${gameRoot(instance)}/.webprism-resources/${kind}/${encodeURIComponent(target.id)}--${encodeURIComponent(fileName)}.json`;
}

async function readMetadata(
  instance: InstanceSummary,
  kind: ResourceKind,
  target: ResourceTarget,
  fileName: string,
): Promise<InstalledResourceMetadata | undefined> {
  return (await opfs.readOptionalJson<InstalledResourceMetadata>(metadataPath(instance, kind, target, fileName)).catch(() => null)) ?? undefined;
}

export async function writeResourceMetadata(
  instance: InstanceSummary,
  kind: ResourceKind,
  target: ResourceTarget,
  metadata: InstalledResourceMetadata,
): Promise<void> {
  await opfs.writeJson(metadataPath(instance, kind, target, metadata.filename), metadata);
}

export async function listInstalledResources(
  instance: InstanceSummary,
  kind: ResourceKind,
  target: ResourceTarget,
): Promise<InstalledResource[]> {
  await opfs.ensureDir(target.opfsPath);
  const entries = await opfs.list(target.opfsPath);
  const resources: InstalledResource[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.kind === "file" && !isResourceFileName(kind, entry.name)) continue;
    const enabled = !entry.name.toLowerCase().endsWith(".disabled");
    const stat = entry.kind === "file" ? await opfs.stat(entry.path) : null;
    resources.push({
      fileName: entry.name,
      displayName: stripDisabledSuffix(entry.name),
      kind,
      target,
      opfsPath: entry.path,
      entryKind: entry.kind,
      enabled,
      size: stat?.size,
      lastModified: stat?.lastModified,
      metadata: entry.kind === "file" ? await readMetadata(instance, kind, target, entry.name) : undefined,
    });
  }

  resources.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return resources;
}

async function removeEnabledCounterpart(target: ResourceTarget, fileName: string): Promise<void> {
  const display = stripDisabledSuffix(fileName);
  const counterpart = fileName === display ? `${display}.disabled` : display;
  await opfs.removeIfExists(`${target.opfsPath}/${counterpart}`);
}

export async function installLocalResourceFiles(
  instance: InstanceSummary,
  kind: ResourceKind,
  target: ResourceTarget,
  files: File[],
): Promise<string[]> {
  await opfs.ensureDir(target.opfsPath);
  const installed: string[] = [];
  for (const file of files) {
    const fileName = safeResourceFileName(file.name);
    if (!isResourceFileName(kind, fileName)) {
      throw new Error(`«${fileName}» no parece un ${RESOURCE_DEFINITIONS[kind].singular}. Extensiones válidas: ${RESOURCE_DEFINITIONS[kind].extensions.join(", ")}.`);
    }
    await removeEnabledCounterpart(target, fileName);
    await opfs.writeFile(`${target.opfsPath}/${fileName}`, file);
    await opfs.removeIfExists(metadataPath(instance, kind, target, fileName));
    installed.push(fileName);
  }
  return installed;
}

export async function installDownloadedResource(
  instance: InstanceSummary,
  kind: ResourceKind,
  target: ResourceTarget,
  rawFileName: string,
  data: Blob,
  metadata?: Omit<InstalledResourceMetadata, "filename" | "targetId" | "kind" | "installedAt">,
): Promise<InstalledResource> {
  const fileName = safeResourceFileName(rawFileName);
  if (!isResourceFileName(kind, fileName)) {
    throw new Error(`El archivo remoto «${fileName}» no es válido para ${RESOURCE_DEFINITIONS[kind].label}.`);
  }
  await opfs.ensureDir(target.opfsPath);
  await removeEnabledCounterpart(target, fileName);
  await opfs.writeFile(`${target.opfsPath}/${fileName}`, data);
  if (metadata) {
    await writeResourceMetadata(instance, kind, target, {
      ...metadata,
      filename: fileName,
      targetId: target.id,
      kind,
      installedAt: new Date().toISOString(),
    });
  } else {
    await opfs.removeIfExists(metadataPath(instance, kind, target, fileName));
  }
  const resources = await listInstalledResources(instance, kind, target);
  const installed = resources.find((resource) => resource.fileName === fileName);
  if (!installed) throw new Error(`No se pudo leer de vuelta ${fileName} después de instalarlo.`);
  return installed;
}

export async function deleteInstalledResource(instance: InstanceSummary, resource: InstalledResource): Promise<void> {
  await opfs.remove(resource.opfsPath);
  if (resource.entryKind === "file") {
    await opfs.removeIfExists(metadataPath(instance, resource.kind, resource.target, resource.fileName));
  }
}

export async function setInstalledResourceEnabled(
  instance: InstanceSummary,
  resource: InstalledResource,
  enabled: boolean,
): Promise<InstalledResource> {
  if (resource.entryKind !== "file") throw new Error("Solo se pueden activar/desactivar archivos; las carpetas se pueden eliminar o renombrar al exportar.");
  if (resource.enabled === enabled) return resource;
  const nextName = enabled ? stripDisabledSuffix(resource.fileName) : `${stripDisabledSuffix(resource.fileName)}.disabled`;
  const nextPath = `${resource.target.opfsPath}/${nextName}`;
  if (await opfs.fileExists(nextPath)) {
    throw new Error(`Ya existe otra copia llamada ${nextName}. Elimina una antes.`);
  }
  await opfs.moveFile(resource.opfsPath, nextPath);
  const oldMeta = await readMetadata(instance, resource.kind, resource.target, resource.fileName);
  await opfs.removeIfExists(metadataPath(instance, resource.kind, resource.target, resource.fileName));
  if (oldMeta) {
    await writeResourceMetadata(instance, resource.kind, resource.target, { ...oldMeta, filename: nextName });
  }
  const resources = await listInstalledResources(instance, resource.kind, resource.target);
  return resources.find((candidate) => candidate.fileName === nextName) ?? { ...resource, fileName: nextName, opfsPath: nextPath, enabled };
}

export async function findInstalledByProjectId(
  instance: InstanceSummary,
  kind: ResourceKind,
  target: ResourceTarget,
  projectId: string,
): Promise<InstalledResource | undefined> {
  const resources = await listInstalledResources(instance, kind, target);
  return resources.find((resource) => resource.metadata?.projectId === projectId);
}

export async function listWorldNames(instance: InstanceSummary): Promise<string[]> {
  const saves = await opfs.list(`${gameRoot(instance)}/saves`);
  return saves.filter((entry) => entry.kind === "directory").map((entry) => entry.name).sort((a, b) => a.localeCompare(b));
}
