import "./style.css";

import { checkLwjgl2Runtime, isGameRunning, runCheerpjPlan } from "./cheerpj";
import { isValidOfflineUsername, offlineUuid } from "./crypto";
import { formatBytes } from "./download";
import {
  createInstance,
  deleteInstance,
  installInstanceComponents,
  listInstances,
  removeInstanceComponents,
  renameInstance,
  touchInstanceLaunchTimes,
  updateInstanceSidecar,
  updateInstanceVersion,
  type ComponentInstallInput,
} from "./instances";
import { LauncherService, type LaunchPlan, type ResolvedInstanceProfile } from "./launcherService";
import {
  detectLocalFolder,
  exportInstanceToLocal,
  exportMinecraftGameDirToLocal,
  getInstanceDirHandle,
  getSharedCacheDir,
  importMinecraftFolderAsInstance,
  importPrismInstance,
  importPrismInstancesRoot,
  linkSharedCache,
  localChildDir,
  pickDirectory,
  supportsDirectoryPicker,
} from "./localFolder";
import {
  ModrinthService,
  modrinthContextForInstance,
  type ModrinthContext,
  type ModrinthSearchHit,
  type ModrinthVersion,
} from "./modrinth";
import { opfs } from "./opfs";
import {
  INTERMEDIARY_UID,
  PRIMARY_LOADER_UIDS,
  describeComponent,
  isLoaderComponent,
  primaryLoaderComponent,
} from "./prism";
import {
  LOADER_DEFINITIONS,
  PrismMetaService,
  loaderSupportsMinecraft,
  type PrismMetaVersionEntry,
  type ResolvedMetaComponent,
} from "./prismMeta";
import {
  RESOURCE_DEFINITIONS,
  deleteInstalledResource,
  installLocalResourceFiles,
  listInstalledResources,
  listResourceTargets,
  listWorldNames,
  setInstalledResourceEnabled,
  type InstalledResource,
  type ResourceKind,
  type ResourceTarget,
} from "./resources";
import {
  DEFAULT_SETTINGS,
  type BackendId,
  type InstanceSummary,
  type LauncherSettings,
  type LogListener,
  type ProgressEvent,
} from "./types";

const SETTINGS_KEY = "webprism:settings:v1";
const SELECTED_INSTANCE_KEY = "webprism:selected-instance:v1";
const FALLBACK_VERSIONS = ["1.21.4", "1.21.1", "1.20.1", "1.16.5", "1.12.2", "1.8.9", "1.7.10", "1.6.4", "1.5.2", "1.2.5"];

type EditPage = "version" | ResourceKind | "worlds" | "game" | "log" | "settings";

interface VersionOption {
  id: string;
  type: string;
  releaseTime?: string;
  local: boolean;
}

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Falta el elemento #${id}`);
  return found as T;
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function loadSettings(): LauncherSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS, aotUrls: {} };
    const parsed = JSON.parse(raw) as Partial<LauncherSettings>;
    return { ...DEFAULT_SETTINGS, ...parsed, aotUrls: { ...(parsed.aotUrls ?? {}) } };
  } catch {
    return { ...DEFAULT_SETTINGS, aotUrls: {} };
  }
}

const el = {
  homeView: element<HTMLElement>("home-view"),
  editView: element<HTMLElement>("edit-view"),
  instanceSearch: element<HTMLInputElement>("instance-search"),
  instanceSort: element<HTMLSelectElement>("instance-sort"),
  instanceCount: element<HTMLElement>("instance-count"),
  instanceList: element<HTMLDivElement>("instance-list"),
  selectedName: element<HTMLElement>("selected-name"),
  selectedMeta: element<HTMLElement>("selected-meta"),
  launchReadiness: element<HTMLDivElement>("launch-readiness"),
  storageEstimate: element<HTMLElement>("storage-estimate"),
  accountName: element<HTMLElement>("account-name"),
  accountSubtitle: element<HTMLElement>("account-subtitle"),
  accountAvatar: element<HTMLElement>("account-avatar"),
  editTitle: element<HTMLElement>("edit-title"),
  editMeta: element<HTMLElement>("edit-meta"),
  versionSummary: element<HTMLElement>("version-summary"),
  componentsList: element<HTMLDivElement>("components-list"),
  planBox: element<HTMLDivElement>("plan-box"),
  backendSelect: element<HTMLSelectElement>("backend-select"),
  windowWidth: element<HTMLInputElement>("window-width"),
  windowHeight: element<HTMLInputElement>("window-height"),
  aotUrl: element<HTMLInputElement>("aot-url"),
  resourceTitle: element<HTMLElement>("resource-title"),
  resourcePath: element<HTMLElement>("resource-path"),
  resourceTarget: element<HTMLSelectElement>("resource-target"),
  resourceContext: element<HTMLDivElement>("resource-context"),
  resourceSearch: element<HTMLInputElement>("resource-search"),
  resourcesList: element<HTMLDivElement>("resources-list"),
  resourceDetails: element<HTMLDivElement>("resource-details"),
  toggleResource: element<HTMLButtonElement>("toggle-resource"),
  worldsList: element<HTMLDivElement>("worlds-list"),
  gameStage: element<HTMLDivElement>("game-stage"),
  gameDisplay: element<HTMLDivElement>("game-display"),
  aotFrame: element<HTMLIFrameElement>("aot-frame"),
  gameStatus: element<HTMLElement>("game-status"),
  log: element<HTMLTextAreaElement>("log"),
  progressLabel: element<HTMLElement>("progress-label"),
  progressDetail: element<HTMLElement>("progress-detail"),
  progressBar: element<HTMLProgressElement>("progress-bar"),

  username: element<HTMLInputElement>("username"),
  offlineUuid: element<HTMLElement>("offline-uuid"),
  eula: element<HTMLInputElement>("eula-accepted"),
  proxyBase: element<HTMLInputElement>("proxy-base"),
  prismMetaUrl: element<HTMLInputElement>("prism-meta-url"),
  cheerpjLoader: element<HTMLInputElement>("cheerpj-loader"),
  concurrency: element<HTMLInputElement>("concurrency"),

  newDialog: element<HTMLDialogElement>("new-instance-dialog"),
  newName: element<HTMLInputElement>("new-instance-name"),
  newSourceList: element<HTMLSelectElement>("new-source-list"),
  newCustomPanel: element<HTMLDivElement>("new-custom-panel"),
  newImportPanel: element<HTMLDivElement>("new-import-panel"),
  newImportTitle: element<HTMLElement>("new-import-title"),
  newImportText: element<HTMLElement>("new-import-text"),
  newQuickList: element<HTMLSelectElement>("new-quick-list"),
  newVersionSearch: element<HTMLInputElement>("new-version-search"),
  newVersionList: element<HTMLSelectElement>("new-version-list"),
  newCustomProfile: element<HTMLInputElement>("new-custom-profile"),
  newLoaderList: element<HTMLSelectElement>("new-loader-list"),
  newLoaderVersionList: element<HTMLSelectElement>("new-loader-version-list"),
  newLoaderStatus: element<HTMLElement>("new-loader-status"),
  newSummary: element<HTMLDivElement>("new-summary"),
  createInstance: element<HTMLButtonElement>("create-instance"),
  createAndPlay: element<HTMLButtonElement>("create-and-play"),

  changeDialog: element<HTMLDialogElement>("change-version-dialog"),
  changeVersionSearch: element<HTMLInputElement>("change-version-search"),
  changeVersionList: element<HTMLSelectElement>("change-version-list"),
  changeSummary: element<HTMLElement>("change-version-summary"),

  loaderDialog: element<HTMLDialogElement>("loader-dialog"),
  loaderContext: element<HTMLElement>("loader-dialog-context"),
  loaderList: element<HTMLSelectElement>("loader-list"),
  loaderVersionList: element<HTMLSelectElement>("loader-version-list"),
  loaderStatus: element<HTMLElement>("loader-status"),

  importVersionDialog: element<HTMLDialogElement>("import-version-dialog"),
  importVersionList: element<HTMLSelectElement>("import-version-list"),

  downloadDialog: element<HTMLDialogElement>("download-dialog"),
  downloadTitle: element<HTMLElement>("download-title"),
  downloadContext: element<HTMLElement>("download-context"),
  downloadSearch: element<HTMLInputElement>("download-search"),
  downloadSort: element<HTMLSelectElement>("download-sort"),
  downloadResults: element<HTMLDivElement>("download-results"),
  downloadStatus: element<HTMLElement>("download-status"),
  downloadVersionList: element<HTMLSelectElement>("download-version-list"),
  downloadVersionDetails: element<HTMLDivElement>("download-version-details"),
  installDownloadVersion: element<HTMLButtonElement>("install-download-version"),
  downloadMore: element<HTMLButtonElement>("download-more"),

  resourceFileInput: element<HTMLInputElement>("resource-file-input"),
};

let settings = loadSettings();
let instances: InstanceSummary[] = [];
let selectedInstance: InstanceSummary | null = null;
let busy = false;
let resourceBusy = false;
let serviceWorkerControlled = false;
let aotRunning = false;

let lastResolved: ResolvedInstanceProfile | null = null;
let lastPlan: LaunchPlan | null = null;
let lastResolvedInstanceId: string | null = null;

let versionOptions: VersionOption[] = FALLBACK_VERSIONS.map((id) => ({ id, type: "release", local: false }));
let localVersionIds = new Set<string>();
let latestReleaseId = "1.21.4";

let currentView: "home" | "edit" = "home";
let currentEditPage: EditPage = "version";
let currentResourceKind: ResourceKind = "mods";
let currentResourceTargets: ResourceTarget[] = [];
let currentResourceTarget: ResourceTarget | null = null;
let currentResources: InstalledResource[] = [];
let selectedResourceName: string | null = null;

let newNameTouched = false;
let newLoaderToken = 0;
let dialogLoaderToken = 0;
let pendingLaunchAfterCreate = false;
let importVersionResolver: ((version: string | null) => void) | null = null;

const downloadState = {
  hits: [] as ModrinthSearchHit[],
  versions: [] as ModrinthVersion[],
  selectedHit: null as ModrinthSearchHit | null,
  total: 0,
  searchToken: 0,
  versionToken: 0,
  canInstall: true,
};

const log: LogListener = (line, level = "info") => {
  const time = new Date().toLocaleTimeString("es-ES", { hour12: false });
  const prefix = level === "error" ? "ERROR" : level === "warn" ? "AVISO" : level === "ok" ? "OK" : "INFO";
  el.log.value += `[${time}] ${prefix} ${line}\n`;
  const lines = el.log.value.split("\n");
  if (lines.length > 900) el.log.value = lines.slice(lines.length - 900).join("\n");
  el.log.scrollTop = el.log.scrollHeight;
  const consoleFn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  consoleFn(`[WebPrism] ${line}`);
};

const prismMeta = new PrismMetaService({
  proxyBase: () => settings.proxyBase,
  baseUrl: () => settings.prismMetaBaseUrl,
  log,
});
const service = new LauncherService({
  proxyBase: () => settings.proxyBase,
  prismMeta,
  concurrency: () => settings.concurrency,
  log,
});
const modrinth = new ModrinthService({
  fetchOptions: () => ({ proxyBase: settings.proxyBase }),
  log,
});

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function friendlyNetworkError(error: unknown, serviceName: string): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("HTTP 404")) return `${serviceName} no encontró el archivo pedido (HTTP 404).`;
  if (message.includes("Failed to fetch") || message.includes("HTTP 502") || message.includes("No se pudo descargar")) {
    return `No se pudo contactar con ${serviceName}. Revisa tu conexión y vuelve a intentarlo. El detalle técnico está en Registro.`;
  }
  return message.length > 220 ? `${message.slice(0, 220)}…` : message;
}

function showDialog(dialog: HTMLDialogElement): void {
  if (!dialog.open) dialog.showModal();
}

function closeDialog(dialog: HTMLDialogElement): void {
  if (dialog.open) dialog.close();
}

function closeMenus(): void {
  document.querySelectorAll<HTMLDetailsElement>("details.menu[open]").forEach((menu) => {
    menu.open = false;
  });
}

function setProgress(event: ProgressEvent | null): void {
  if (!event) {
    el.progressLabel.textContent = "Listo.";
    el.progressDetail.textContent = "";
    el.progressBar.max = 1;
    el.progressBar.value = 0;
    return;
  }
  const finiteTotal = event.total > 0 ? event.total : 1;
  el.progressLabel.textContent = event.phase;
  const byteText = event.bytesTotal
    ? ` · ${formatBytes(event.bytesDone ?? 0)} / ${formatBytes(event.bytesTotal)}`
    : event.bytesDone
      ? ` · ${formatBytes(event.bytesDone)}`
      : "";
  el.progressDetail.textContent = `${Math.min(event.done, finiteTotal)}/${finiteTotal}${byteText}${event.current ? ` · ${event.current}` : ""}`;
  el.progressBar.max = finiteTotal;
  el.progressBar.value = Math.min(event.done, finiteTotal);
}

function setBusy(nextBusy: boolean, label?: string): void {
  busy = nextBusy;
  const keepEnabled = new Set(["stop-game", "fullscreen-game", "clear-log", "back-home", "close-edit"]);
  document
    .querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("button, input, select, textarea")
    .forEach((control) => {
      const keep = keepEnabled.has(control.id) || control.closest("dialog") !== null || control.classList.contains("page-link");
      control.disabled = nextBusy && !keep;
    });
  if (nextBusy && label) {
    el.progressLabel.textContent = label;
    el.progressDetail.textContent = "Trabajando…";
  }
  if (!nextBusy) setProgress(null);
}

async function runTask(label: string, task: () => Promise<void>): Promise<void> {
  if (busy) {
    log("Ya hay una tarea en curso en el launcher.", "warn");
    return;
  }
  setBusy(true, label);
  try {
    await task();
  } catch (error) {
    if (isAbortError(error)) log("Operación cancelada.", "warn");
    else log(error instanceof Error ? error.message : String(error), "error");
  } finally {
    setBusy(false);
    void updateStorageEstimate();
  }
}

function saveSettings(): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function persistSettingsFromForm(): LauncherSettings {
  settings = {
    ...settings,
    username: el.username.value.trim(),
    eulaAccepted: el.eula.checked,
    proxyBase: el.proxyBase.value.trim(),
    prismMetaBaseUrl: el.prismMetaUrl.value.trim() || DEFAULT_SETTINGS.prismMetaBaseUrl,
    cheerpjLoaderUrl: el.cheerpjLoader.value.trim() || DEFAULT_SETTINGS.cheerpjLoaderUrl,
    concurrency: Math.max(1, Math.min(32, Number.parseInt(el.concurrency.value, 10) || DEFAULT_SETTINGS.concurrency)),
  };
  saveSettings();
  updateAccountPreview();
  return settings;
}

function fillSettingsForm(): void {
  el.username.value = settings.username;
  el.eula.checked = settings.eulaAccepted;
  el.proxyBase.value = settings.proxyBase;
  el.prismMetaUrl.value = settings.prismMetaBaseUrl;
  el.cheerpjLoader.value = settings.cheerpjLoaderUrl;
  el.concurrency.value = String(settings.concurrency);
  updateAccountPreview();
}

function updateAccountPreview(): void {
  const username = el.username.value.trim() || settings.username || "Steve";
  el.offlineUuid.textContent = username ? offlineUuid(username, true) : "—";
  el.accountName.textContent = username;
  el.accountAvatar.textContent = username.slice(0, 1).toUpperCase() || "S";
  el.accountSubtitle.textContent = isValidOfflineUsername(username)
    ? el.eula.checked
      ? "Offline · listo"
      : "Offline · falta EULA"
    : "Nombre no válido";
  renderLaunchReadiness();
}

async function updateStorageEstimate(): Promise<void> {
  const estimate = await opfs.estimate().catch((): { usage?: number; quota?: number } => ({}));
  el.storageEstimate.textContent =
    estimate.usage !== undefined && estimate.quota !== undefined
      ? `Almacenamiento del navegador: ${formatBytes(estimate.usage)} / ${formatBytes(estimate.quota)}`
      : "Almacenamiento del navegador: sin estimación disponible";
}

function setCapability(id: string, state: "ok" | "warn" | "missing", text: string): void {
  const chip = element<HTMLElement>(id);
  chip.className = `capability ${state}`;
  chip.textContent = text;
}

function selected(): InstanceSummary | null {
  return selectedInstance;
}

function requireSelected(): InstanceSummary {
  if (!selectedInstance) throw new Error("Crea o selecciona una instancia primero.");
  return selectedInstance;
}

function componentVersion(component: InstanceSummary["components"][number]): string | undefined {
  return component.version ?? component.cachedVersion;
}

function loaderSummary(instance: InstanceSummary): string {
  const loader = primaryLoaderComponent(instance.components);
  if (loader) return `${describeComponent(loader.uid)} ${componentVersion(loader) ?? ""}`.trim();
  const inferred = modrinthContextForInstance(instance).loaderSlugs[0];
  if (inferred) return `${inferred} (perfil)`;
  return "Ninguno";
}

function parseRelease(id: string): [number, number, number] | null {
  const match = /^1\.(\d+)(?:\.(\d+))?$/.exec(id);
  if (!match) return null;
  return [1, Number(match[1]), Number(match[2] ?? 0)];
}

function compareRelease(id: string, other: string): number | null {
  const a = parseRelease(id);
  const b = parseRelease(other);
  if (!a || !b) return null;
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

function quickVersionWebStatus(id: string): { kind: "ok" | "warn" | "blocked"; label: string } {
  if (id === "1.2.5") return { kind: "ok", label: "Recomendado" };
  const cmp112 = compareRelease(id, "1.12.2");
  if (cmp112 !== null) return cmp112 <= 0 ? { kind: "warn", label: "Experimental" } : { kind: "blocked", label: "Gestionar/exportar" };
  if (/^\d{2}w\d{2}/.test(id) || /^[2-9]\d*(?:\.|$)/.test(id)) return { kind: "blocked", label: "Probablemente moderno" };
  return { kind: "warn", label: "Comprobar" };
}

function instanceWebStatus(instance: InstanceSummary): { kind: "ok" | "warn" | "blocked"; label: string } {
  if (lastResolved && lastResolvedInstanceId === instance.id && selectedInstance?.id === instance.id) {
    const status = lastResolved.compatibility.status;
    if (status === "known-good") return { kind: "ok", label: "Compatible" };
    if (status === "blocked") return { kind: "blocked", label: "Bloqueado" };
    return { kind: "warn", label: "Experimental" };
  }
  if (instance.sidecar.backend === "aot" || aotUrlFromFormOrInstance(instance)) return { kind: "ok", label: "AOT configurado" };
  if (instance.sidecar.backend === "manage") return { kind: "warn", label: "Solo gestionar" };
  const status = quickVersionWebStatus(instance.minecraftVersion);
  if (status.kind !== "blocked" && primaryLoaderComponent(instance.components)) {
    return { kind: "warn", label: "Loader experimental" };
  }
  return status;
}

function formatLastPlayed(timestamp: number): string {
  if (!timestamp) return "Nunca";
  return new Date(timestamp).toLocaleDateString("es-ES", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function renderInstanceList(): void {
  const query = el.instanceSearch.value.trim().toLowerCase();
  const sort = el.instanceSort.value;
  const visible = instances
    .filter((instance) => {
      if (!query) return true;
      return `${instance.name} ${instance.id} ${instance.minecraftVersion} ${loaderSummary(instance)}`.toLowerCase().includes(query);
    })
    .sort((a, b) => {
      if (sort === "last") return b.lastLaunchTime - a.lastLaunchTime || a.name.localeCompare(b.name);
      if (sort === "version") return b.minecraftVersion.localeCompare(a.minecraftVersion) || a.name.localeCompare(b.name);
      return a.name.localeCompare(b.name);
    });

  el.instanceCount.textContent = instances.length ? `${visible.length} de ${instances.length} instancia(s)` : "";
  el.instanceList.replaceChildren();

  if (!instances.length) {
    const empty = document.createElement("div");
    empty.className = "empty-instances";
    empty.innerHTML = `
      <img src="/prismlauncher.svg" alt="" />
      <h2>Empieza aquí</h2>
      <p>1. Pulsa <strong>Añadir instancia</strong>.<br />2. Elige una versión de Minecraft en la lista.<br />3. Si quieres mods, elige Forge, NeoForge, Fabric, Quilt o LiteLoader en la lista.<br />4. Pulsa <strong>Crear e iniciar</strong>.</p>
      <div class="empty-actions">
        <button type="button" class="qt-button primary" data-empty-action="new">+ Añadir instancia</button>
        <button type="button" class="qt-button" data-empty-action="import-prism">Importar de Prism…</button>
        <button type="button" class="qt-button" data-empty-action="import-minecraft">Importar .minecraft…</button>
      </div>`;
    empty.querySelectorAll<HTMLButtonElement>("[data-empty-action]").forEach((button) => {
      button.addEventListener("click", () => {
        const action = button.dataset.emptyAction;
        if (action === "new") openNewInstanceDialog();
        else if (action === "import-prism") void runTask("Importando Prism", importPrismFlow);
        else void runTask("Importando .minecraft", importMinecraftFlow);
      });
    });
    el.instanceList.appendChild(empty);
    return;
  }

  if (!visible.length) {
    const empty = document.createElement("div");
    empty.className = "empty-list";
    empty.textContent = "Ninguna instancia coincide con la búsqueda.";
    el.instanceList.appendChild(empty);
    return;
  }

  for (const instance of visible) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `instance-row${instance.id === selectedInstance?.id ? " selected" : ""}`;
    row.dataset.instanceId = instance.id;
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(instance.id === selectedInstance?.id));
    const web = instanceWebStatus(instance);
    row.innerHTML = `
      <span class="row-icon"><img src="/prismlauncher.svg" alt="" /></span>
      <span class="row-name" title="${escapeHtml(instance.id)}">${escapeHtml(instance.name)}</span>
      <span>${escapeHtml(instance.minecraftVersion || "—")}</span>
      <span class="row-muted">${escapeHtml(loaderSummary(instance))}</span>
      <span>${instance.modCount}</span>
      <span>${instance.saveCount}</span>
      <span class="row-muted">${escapeHtml(formatLastPlayed(instance.lastLaunchTime))}</span>
      <span class="status-text ${web.kind}">${escapeHtml(web.label)}</span>`;
    row.addEventListener("click", () => selectInstance(instance.id));
    row.addEventListener("dblclick", () => {
      selectInstance(instance.id);
      launchSelected();
    });
    el.instanceList.appendChild(row);
  }
}

function renderLaunchReadiness(): void {
  if (!el.launchReadiness) return;
  const instance = selectedInstance;
  const username = el.username.value.trim();
  const issues: string[] = [];
  if (!instance) issues.push("Crea o selecciona una instancia.");
  if (!isValidOfflineUsername(username)) issues.push("Pon un nombre offline válido (3–16 caracteres).");
  if (!el.eula.checked) issues.push("Acepta el EULA en la cuenta offline.");
  if (instance) {
    const web = instanceWebStatus(instance);
    if (web.kind === "blocked") issues.push("Esta versión se puede gestionar/exportar, pero el runtime web aún no la ejecuta.");
  }
  el.launchReadiness.className = `readiness-box ${issues.length ? (instance && instanceWebStatus(instance).kind === "blocked" ? "error" : "warn") : "ok"}`;
  el.launchReadiness.innerHTML = issues.length
    ? `<strong>Antes de jugar:</strong><br />${issues.map(escapeHtml).join("<br />")}`
    : "<strong>Listo.</strong> Pulsa Iniciar: se descargará y verificará el juego si falta.";
}

function renderSelected(): void {
  const instance = selectedInstance;
  el.selectedName.textContent = instance?.name ?? "Sin instancia";
  el.selectedMeta.textContent = instance
    ? `${instance.minecraftVersion || "Sin versión"} · ${loaderSummary(instance)} · ${instance.modCount} mods`
    : "Crea tu primera instancia para empezar.";
  el.editTitle.textContent = instance?.name ?? "Instancia";
  el.editMeta.textContent = instance
    ? `${instance.id} · Minecraft ${instance.minecraftVersion || "—"} · ${loaderSummary(instance)} · ${instanceWebStatus(instance).label}`
    : "";
  element<HTMLElement>("quick-mod-count").textContent = String(instance?.modCount ?? 0);
  element<HTMLElement>("quick-resourcepack-count").textContent = String(instance?.resourcePackCount ?? 0);
  element<HTMLElement>("quick-shaderpack-count").textContent = String(instance?.shaderPackCount ?? 0);
  element<HTMLElement>("quick-datapack-count").textContent = String(instance?.dataPackCount ?? 0);
  document.querySelectorAll<HTMLElement>("[data-count]").forEach((badge) => {
    const key = badge.dataset.count;
    badge.textContent = String(
      key === "mods"
        ? instance?.modCount ?? 0
        : key === "resourcepacks"
          ? instance?.resourcePackCount ?? 0
          : key === "shaderpacks"
            ? instance?.shaderPackCount ?? 0
            : key === "datapacks"
              ? instance?.dataPackCount ?? 0
              : instance?.saveCount ?? 0,
    );
  });

  if (instance) {
    el.backendSelect.value = instance.sidecar.backend;
    el.windowWidth.value = String(instance.sidecar.windowWidth || 854);
    el.windowHeight.value = String(instance.sidecar.windowHeight || 480);
    el.aotUrl.value = instance.sidecar.aotUrl ?? settings.aotUrls[instance.minecraftVersion] ?? "";
  }
  renderLaunchReadiness();
  renderComponents();
  renderPlanDetails();
}

function selectInstance(id: string): void {
  const next = instances.find((instance) => instance.id === id) ?? null;
  if (!next) return;
  const changed = selectedInstance?.id !== next.id;
  selectedInstance = next;
  localStorage.setItem(SELECTED_INSTANCE_KEY, next.id);
  if (changed) {
    lastResolved = null;
    lastPlan = null;
    lastResolvedInstanceId = null;
    currentResources = [];
    selectedResourceName = null;
    currentResourceTarget = null;
  }
  renderInstanceList();
  renderSelected();
  if (currentView === "edit" && changed) void refreshCurrentEditData();
}

async function refreshInstances(preferredId?: string): Promise<void> {
  const previousId = selectedInstance?.id;
  instances = await listInstances();
  const wanted = preferredId ?? localStorage.getItem(SELECTED_INSTANCE_KEY) ?? previousId;
  selectedInstance = instances.find((instance) => instance.id === wanted) ?? instances[0] ?? null;
  if (selectedInstance) localStorage.setItem(SELECTED_INSTANCE_KEY, selectedInstance.id);
  if (selectedInstance?.id !== previousId) {
    lastResolved = null;
    lastPlan = null;
    lastResolvedInstanceId = null;
  }
  renderInstanceList();
  renderSelected();
  await updateStorageEstimate();
}

function showHome(): void {
  currentView = "home";
  el.homeView.hidden = false;
  el.editView.hidden = true;
}

function showEdit(page: EditPage = "version"): void {
  if (!selectedInstance) {
    openNewInstanceDialog();
    return;
  }
  currentView = "edit";
  el.homeView.hidden = true;
  el.editView.hidden = false;
  renderSelected();
  setEditPage(page);
}

function setEditPage(page: EditPage): void {
  currentEditPage = page;
  const isResource = page === "mods" || page === "resourcepacks" || page === "shaderpacks" || page === "datapacks";
  if (isResource) currentResourceKind = page;
  document.querySelectorAll<HTMLButtonElement>(".page-link").forEach((button) => {
    button.classList.toggle("active", button.dataset.page === page);
  });
  element<HTMLElement>("page-version").hidden = page !== "version";
  element<HTMLElement>("page-resources").hidden = !isResource;
  element<HTMLElement>("page-worlds").hidden = page !== "worlds";
  element<HTMLElement>("page-game").hidden = page !== "game";
  element<HTMLElement>("page-log").hidden = page !== "log";
  element<HTMLElement>("page-settings").hidden = page !== "settings";
  if (currentView !== "edit") return;
  if (isResource) void refreshResourcePage();
  if (page === "worlds") void renderWorlds();
}

async function refreshCurrentEditData(): Promise<void> {
  if (currentEditPage === "mods" || currentEditPage === "resourcepacks" || currentEditPage === "shaderpacks" || currentEditPage === "datapacks") {
    await refreshResourcePage();
  } else if (currentEditPage === "worlds") {
    await renderWorlds();
  }
}

function renderComponents(): void {
  const instance = selectedInstance;
  el.componentsList.replaceChildren();
  if (!instance) {
    el.versionSummary.textContent = "Sin instancia seleccionada.";
    return;
  }
  const loader = primaryLoaderComponent(instance.components);
  el.versionSummary.innerHTML = `Minecraft <strong>${escapeHtml(instance.minecraftVersion || "sin versión")}</strong> · ${loader ? `<strong>${escapeHtml(loaderSummary(instance))}</strong>` : "Sin mod loader (Vanilla)"} · formato Prism en <code>mmc-pack.json</code>`;

  const rows: Array<{ name: string; uid: string; version: string; status: string; action?: string }> = [];
  const seen = new Set<string>();
  for (const component of instance.components) {
    const version = componentVersion(component) ?? "";
    if ((component.uid === "org.lwjgl3" || component.uid === "org.lwjgl") && !version) {
      rows.push({ name: describeComponent(component.uid), uid: component.uid, version: "incluido", status: "Lo declara el perfil de Minecraft" });
      seen.add(component.uid);
      continue;
    }
    seen.add(component.uid);
    rows.push({
      name: component.cachedName ?? describeComponent(component.uid),
      uid: component.uid,
      version: version || "—",
      status: component.disabled ? "Desactivado" : component.dependencyOnly ? "Dependencia del loader" : "En mmc-pack.json",
      action: isLoaderComponent(component.uid) || component.uid === INTERMEDIARY_UID ? component.uid : undefined,
    });
  }
  if (!seen.has("net.minecraft") && instance.minecraftVersion) {
    rows.unshift({ name: "Minecraft", uid: "net.minecraft", version: instance.minecraftVersion, status: "Versión base" });
  }
  if (!loader) {
    rows.push({ name: "Mod loader", uid: "—", version: "Ninguno", status: "Minecraft vanilla", action: "install-loader" });
  }

  for (const item of rows) {
    const row = document.createElement("div");
    row.className = "component-row";
    row.innerHTML = `
      <span><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.uid)}</small></span>
      <span>${escapeHtml(item.version)}</span>
      <span class="row-muted">${escapeHtml(item.status)}</span>
      <span>${item.action === "install-loader" ? `<button type="button" class="qt-button" data-install-loader="true">Instalar…</button>` : item.action ? `<button type="button" class="qt-button" data-remove-component="${escapeHtml(item.action)}">Quitar</button>` : ""}</span>`;
    el.componentsList.appendChild(row);
  }
  element<HTMLButtonElement>("remove-loader").disabled = !loader;
}

function renderPlanDetails(): void {
  const resolved = lastPlan && lastPlan.instanceId === selectedInstance?.id
    ? { profile: lastPlan.profile, compatibility: lastPlan.compatibility }
    : lastResolved && lastResolvedInstanceId === selectedInstance?.id
      ? lastResolved
      : null;
  if (!resolved) {
    el.planBox.innerHTML = `<p class="muted">Todavía no se ha comprobado esta instancia. Al pulsar <strong>Iniciar</strong> se comprueba automáticamente.</p>`;
    return;
  }
  const { profile, compatibility } = resolved;
  const classpathCount = lastResolved?.classified.filter((entry) => entry.includeOnClasspath).length ?? profile.libraries.length;
  const statusClass = compatibility.status === "blocked" ? "bad" : compatibility.status === "known-good" ? "ok" : "warn";
  const stats: Array<[string, string]> = [
    ["Perfil", profile.id],
    ["Cliente Mojang", profile.clientVersionId],
    ["Main class", profile.mainClass || "—"],
    ["Java", `${profile.javaMajor} → CheerpJ ${compatibility.javaRuntime ?? "sin runtime"}`],
    ["Librerías", `${profile.libraries.length} declaradas · ${classpathCount} en classpath`],
    ["Assets", profile.assetIndex?.id ?? "sin assetIndex"],
    ["Gráficos", compatibility.hasLwjgl3 ? "LWJGL3 (bloqueado en web)" : compatibility.hasLwjgl2 ? "LWJGL2 wasm + gl4es" : "CheerpJ genérico"],
    ["Fuente", profile.sourceChain.join(" → ")],
  ];
  if (lastPlan && lastPlan.instanceId === selectedInstance?.id) {
    stats.push(["Descargas", `${lastPlan.downloads.files} archivos · ${formatBytes(lastPlan.downloads.bytes)}`]);
    stats.push(["GameDir JVM", lastPlan.gameDirJvmPath]);
  }
  const reasons = [...compatibility.reasons, ...profile.warnings.filter((warning) => !compatibility.reasons.includes(warning))];
  el.planBox.innerHTML = `
    <h4><span class="status-pill ${statusClass}">${escapeHtml(compatibility.title)}</span></h4>
    <div class="plan-grid">${stats.map(([label, value]) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join("")}</div>
    ${compatibility.blockers.length ? `<h4>Bloqueos</h4><ul>${compatibility.blockers.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : ""}
    ${reasons.length ? `<h4>Notas</h4><ul>${reasons.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : ""}
    ${lastPlan && lastPlan.instanceId === selectedInstance?.id ? `<details><summary>Argumentos del juego</summary><pre>${escapeHtml(lastPlan.gameArgs.join("\n"))}</pre></details>` : ""}
    ${lastPlan && lastPlan.instanceId === selectedInstance?.id ? `<details><summary>Classpath JVM</summary><pre>${escapeHtml(lastPlan.classpathJvmPaths.join("\n"))}</pre></details>` : ""}`;
}

function versionCategory(option: VersionOption): "release" | "snapshot" | "beta" | "alpha" | "experiment" | "local" {
  if (option.type === "release") return "release";
  if (option.type === "snapshot") return "snapshot";
  if (option.type === "old_beta") return "beta";
  if (option.type === "old_alpha") return "alpha";
  if (option.type === "local") return "local";
  return "experiment";
}

function versionTypeLabel(option: VersionOption): string {
  return {
    release: "Release",
    snapshot: "Snapshot",
    beta: "Beta",
    alpha: "Alpha",
    experiment: option.type,
    local: "Local",
  }[versionCategory(option)];
}

function getVersionFilters(prefix: "new" | "change") {
  return {
    release: element<HTMLInputElement>(`${prefix}-filter-release`).checked,
    snapshot: element<HTMLInputElement>(`${prefix}-filter-snapshot`).checked,
    beta: element<HTMLInputElement>(`${prefix}-filter-beta`).checked,
    alpha: element<HTMLInputElement>(`${prefix}-filter-alpha`).checked,
    experiment: element<HTMLInputElement>(`${prefix}-filter-experiment`).checked,
    local: element<HTMLInputElement>(`${prefix}-filter-local`).checked,
  } as Record<ReturnType<typeof versionCategory>, boolean>;
}

function fillVersionList(select: HTMLSelectElement, prefix: "new" | "change", preferredId?: string): void {
  const previous = preferredId ?? select.value;
  const query = (prefix === "new" ? el.newVersionSearch.value : el.changeVersionSearch.value).trim().toLowerCase();
  const filters = getVersionFilters(prefix);
  const filtered = versionOptions.filter((option) => {
    if (query && !option.id.toLowerCase().includes(query)) return false;
    return filters[versionCategory(option)] || (filters.local && option.local);
  });
  select.replaceChildren();

  const addOption = (option: VersionOption, suffix = "") => {
    const item = document.createElement("option");
    item.value = option.id;
    const date = option.releaseTime ? new Date(option.releaseTime).toLocaleDateString("es-ES") : "sin fecha";
    const Web = quickVersionWebStatus(option.id);
    item.textContent = `${option.id} · ${versionTypeLabel(option)} · ${date} · ${Web.label}${option.local ? " · en caché" : ""}${suffix}`;
    select.appendChild(item);
  };

  if (preferredId && !filtered.some((option) => option.id === preferredId)) {
    const known = versionOptions.find((option) => option.id === preferredId) ?? { id: preferredId, type: "local", local: true };
    addOption(known, " · actual");
  }
  for (const option of filtered.slice(0, 2500)) addOption(option);

  if (!select.options.length) {
    const item = document.createElement("option");
    item.textContent = "Sin resultados: activa más filtros o cambia la búsqueda";
    item.disabled = true;
    item.selected = true;
    select.appendChild(item);
    return;
  }
  if ([...select.options].some((option) => option.value === previous && !option.disabled)) select.value = previous;
  else select.selectedIndex = 0;
}

function refreshOpenVersionLists(): void {
  fillVersionList(el.newVersionList, "new", el.newVersionList.value || "1.2.5");
  fillVersionList(el.changeVersionList, "change", selectedInstance?.minecraftVersion || el.changeVersionList.value || undefined);
  updateNewSummary();
  updateChangeSummary();
}

async function loadVersions(forceRefresh = false): Promise<void> {
  localVersionIds = new Set(await service.listCachedVersionIds().catch(() => []));
  try {
    const manifest = await service.getManifest(forceRefresh);
    latestReleaseId = manifest.latest.release;
    const byId = new Map<string, VersionOption>();
    for (const version of manifest.versions) {
      byId.set(version.id, {
        id: version.id,
        type: version.type,
        releaseTime: version.releaseTime,
        local: localVersionIds.has(version.id),
      });
    }
    for (const localId of localVersionIds) {
      if (!byId.has(localId)) byId.set(localId, { id: localId, type: "local", local: true });
      else byId.get(localId)!.local = true;
    }
    versionOptions = [...byId.values()];
    log(`Manifiesto de Mojang cargado: ${manifest.versions.length} versiones (última release ${manifest.latest.release}).`, "ok");
  } catch (error) {
    if (!versionOptions.length) versionOptions = FALLBACK_VERSIONS.map((id) => ({ id, type: "release", local: localVersionIds.has(id) }));
    for (const localId of localVersionIds) {
      if (!versionOptions.some((option) => option.id === localId)) versionOptions.push({ id: localId, type: "local", local: true });
    }
    log(`No se pudo cargar el manifiesto de Mojang (${error instanceof Error ? error.message : String(error)}). Se muestra la lista en caché/corta.`, "warn");
  }
  refreshOpenVersionLists();
}

function fillLoaderList(select: HTMLSelectElement, minecraftVersion: string, selectedUid = ""): void {
  const previous = selectedUid || select.value || "";
  select.replaceChildren();
  for (const definition of LOADER_DEFINITIONS) {
    const option = document.createElement("option");
    option.value = definition.uid;
    const supported = !definition.uid || loaderSupportsMinecraft(definition.uid, minecraftVersion);
    option.textContent = definition.uid
      ? `${definition.label}${supported ? "" : " — requiere MC 1.14+"}`
      : "Ninguno (Vanilla)";
    option.disabled = !supported;
    select.appendChild(option);
  }
  const desired = [...select.options].find((option) => option.value === previous && !option.disabled);
  select.value = desired?.value ?? "";
}

function fillNoLoaderVersion(select: HTMLSelectElement, status: HTMLElement): void {
  select.replaceChildren();
  const option = document.createElement("option");
  option.value = "";
  option.textContent = "— Minecraft vanilla, sin loader —";
  option.selected = true;
  select.appendChild(option);
  status.textContent = "Sin loader: se creará/instalará Minecraft vanilla. Puedes añadir un loader después desde Editar → Versión.";
}

function renderLoaderVersionOptions(select: HTMLSelectElement, entries: PrismMetaVersionEntry[], preferred?: string): void {
  select.replaceChildren();
  if (!entries.length) {
    const option = document.createElement("option");
    option.textContent = "Sin versiones para este Minecraft";
    option.disabled = true;
    option.selected = true;
    select.appendChild(option);
    return;
  }
  for (const entry of entries) {
    const option = document.createElement("option");
    option.value = entry.version;
    const date = entry.releaseTime ? new Date(entry.releaseTime).toLocaleDateString("es-ES") : "";
    option.textContent = `${entry.version}${entry.recommended ? " ★ Recomendada" : ""}${entry.type ? ` · ${entry.type}` : ""}${date ? ` · ${date}` : ""}`;
    select.appendChild(option);
  }
  const recommended = entries.find((entry) => entry.recommended)?.version;
  select.value = preferred && entries.some((entry) => entry.version === preferred) ? preferred : recommended ?? entries[0].version;
}

async function refreshLoaderVersions(kind: "new" | "dialog", forceRefresh = false): Promise<void> {
  const isNew = kind === "new";
  const loaderSelect = isNew ? el.newLoaderList : el.loaderList;
  const versionSelect = isNew ? el.newLoaderVersionList : el.loaderVersionList;
  const status = isNew ? el.newLoaderStatus : el.loaderStatus;
  const minecraftVersion = isNew ? el.newCustomProfile.value.trim() || el.newVersionList.value : selectedInstance?.minecraftVersion ?? "";
  const uid = loaderSelect.value;
  const token = isNew ? ++newLoaderToken : ++dialogLoaderToken;
  const isCurrent = () => (isNew ? token === newLoaderToken : token === dialogLoaderToken);
  const preferred = !isNew && selectedInstance
    ? componentVersion(selectedInstance.components.find((component) => component.uid === uid) ?? { uid })
    : versionSelect.value || undefined;

  const updateSummaries = () => {
    if (isNew) updateNewSummary();
    else updateLoaderDialogState();
  };

  if (!uid) {
    fillNoLoaderVersion(versionSelect, status);
    updateSummaries();
    return;
  }
  if (!minecraftVersion) {
    versionSelect.replaceChildren(new Option("Elige primero Minecraft", ""));
    status.textContent = "Elige una versión de Minecraft para filtrar el loader.";
    updateSummaries();
    return;
  }
  if (!loaderSupportsMinecraft(uid, minecraftVersion)) {
    renderLoaderVersionOptions(versionSelect, []);
    status.textContent = "Fabric y Quilt empiezan en Minecraft 1.14. Para versiones antiguas usa Forge o LiteLoader.";
    updateSummaries();
    return;
  }

  versionSelect.replaceChildren(new Option("Cargando desde Prism Meta…", ""));
  status.textContent = `Consultando ${describeComponent(uid)} para Minecraft ${minecraftVersion}…`;
  updateSummaries();
  try {
    const entries = await prismMeta.listLoaderVersions(uid, minecraftVersion, forceRefresh);
    if (!isCurrent()) return;
    renderLoaderVersionOptions(versionSelect, entries, preferred);
    status.textContent = entries.length
      ? `${entries.length} versión(es) compatibles con Minecraft ${minecraftVersion}. La recomendada viene elegida.`
      : `Prism Meta no lista ${describeComponent(uid)} para Minecraft ${minecraftVersion}.`;
  } catch (error) {
    if (!isCurrent()) return;
    renderLoaderVersionOptions(versionSelect, []);
    status.textContent = friendlyNetworkError(error, "Prism Meta");
    log(`Prism Meta: ${error instanceof Error ? error.message : String(error)}`, "warn");
  }
  updateSummaries();
}

function suggestedInstanceName(): string {
  const minecraftVersion = el.newCustomProfile.value.trim() || el.newVersionList.value || "Minecraft";
  const loaderUid = el.newLoaderList.value;
  const loaderVersion = el.newLoaderVersionList.value;
  if (!loaderUid) return `Minecraft ${minecraftVersion}`;
  return `${minecraftVersion} ${describeComponent(loaderUid)}${loaderVersion ? ` ${loaderVersion}` : ""}`;
}

function updateNewSummary(): void {
  const customProfile = el.newCustomProfile.value.trim();
  const minecraftVersion = customProfile || el.newVersionList.value;
  const loaderUid = el.newLoaderList.value;
  const loaderVersion = el.newLoaderVersionList.value;
  if (!newNameTouched) el.newName.value = suggestedInstanceName();

  const customMode = Boolean(customProfile);
  el.newLoaderList.disabled = customMode;
  el.newLoaderVersionList.disabled = customMode;
  if (customMode && loaderUid) {
    el.newLoaderList.value = "";
    fillNoLoaderVersion(el.newLoaderVersionList, el.newLoaderStatus);
  }

  const ready = Boolean(minecraftVersion && (!loaderUid || loaderVersion));
  el.createInstance.disabled = !ready || busy;
  el.createAndPlay.disabled = !ready || busy;
  const webStatus = quickVersionWebStatus(minecraftVersion || "");
  el.newSummary.innerHTML = minecraftVersion
    ? `<strong>Resumen:</strong> Minecraft ${escapeHtml(minecraftVersion)}${loaderUid ? ` + ${escapeHtml(describeComponent(loaderUid))} ${escapeHtml(loaderVersion || "(elige versión)")}` : " vanilla"}.<br /><strong>En web:</strong> ${escapeHtml(webStatus.label)}.${customMode ? " Perfil local avanzado: el loader debería venir ya dentro del perfil importado." : ""}`
    : "Elige una versión de Minecraft de la lista.";
}

function updateChangeSummary(): void {
  const version = el.changeVersionList.value;
  const loader = selectedInstance ? primaryLoaderComponent(selectedInstance.components) : undefined;
  el.changeSummary.innerHTML = version
    ? `<strong>Nueva versión:</strong> ${escapeHtml(version)} · ${escapeHtml(quickVersionWebStatus(version).label)}.${loader ? `<br />Se intentará mantener ${escapeHtml(describeComponent(loader.uid))} ${escapeHtml(componentVersion(loader) ?? "")}; si esa versión del loader no sirve para este Minecraft, se quitará y podrás elegir otra.` : ""}`
    : "Elige una versión de la lista.";
}

function updateLoaderDialogState(): void {
  const uid = el.loaderList.value;
  const version = el.loaderVersionList.value;
  element<HTMLButtonElement>("loader-apply").disabled = Boolean(uid && !version);
}

function setNewSource(source: string): void {
  const custom = source === "custom";
  el.newCustomPanel.hidden = !custom;
  el.newImportPanel.hidden = custom;
  el.createInstance.hidden = !custom;
  el.createAndPlay.hidden = !custom;
  if (!custom) {
    el.newImportTitle.textContent = source === "prism" ? "Importar de Prism" : "Importar .minecraft";
    el.newImportText.textContent = source === "prism"
      ? "Elige una instancia Prism (instance.cfg + mmc-pack.json) o la carpeta raíz instances/. Se copia a OPFS; tu carpeta local no se modifica al importar."
      : "Elige tu carpeta .minecraft o una carpeta de datos con versions/, libraries/ y assets/. Después elegirás el perfil en una lista.";
  }
}

function openNewInstanceDialog(): void {
  newNameTouched = false;
  el.newSourceList.value = "custom";
  setNewSource("custom");
  el.newCustomProfile.value = "";
  fillVersionList(el.newVersionList, "new", el.newVersionList.value || "1.2.5");
  el.newQuickList.value = el.newVersionList.value === "1.12.2" ? "1.12.2" : el.newVersionList.value === latestReleaseId ? "latest" : "1.2.5";
  fillLoaderList(el.newLoaderList, el.newVersionList.value, "");
  void refreshLoaderVersions("new");
  updateNewSummary();
  showDialog(el.newDialog);
  requestAnimationFrame(() => el.newName.select());
}

function resolvedToInstalls(resolved: ResolvedMetaComponent[]): ComponentInstallInput[] {
  return resolved.map((component) => ({
    uid: component.uid,
    version: component.version,
    name: component.name,
    patch: component.patch,
    dependencyOnly: component.dependencyOnly,
    requires: component.patch.requires ?? component.entry.requires,
    conflicts: component.patch.conflicts ?? component.entry.conflicts,
  }));
}

function allLoaderUids(): string[] {
  return [...PRIMARY_LOADER_UIDS, INTERMEDIARY_UID];
}

async function installLoaderIntoInstance(instance: InstanceSummary, uid: string, version: string): Promise<InstanceSummary> {
  if (!uid) {
    const updated = await removeInstanceComponents(instance.id, allLoaderUids());
    log("Mod loader eliminado. La instancia queda en Minecraft vanilla.");
    return updated;
  }
  if (!version) throw new Error(`Elige una versión de ${describeComponent(uid)} en la lista.`);
  const resolved = await prismMeta.resolveLoader(uid, version, instance.minecraftVersion);
  const updated = await installInstanceComponents(instance.id, resolvedToInstalls(resolved), allLoaderUids());
  log(
    `${describeComponent(uid)} ${version} instalado desde Prism Meta${resolved.length > 1 ? ` con ${resolved.length - 1} dependencia(s) de componente` : ""}.`,
    "ok",
  );
  return updated;
}

async function createCustomInstance(startAfter: boolean): Promise<void> {
  pendingLaunchAfterCreate = false;
  await runTask(startAfter ? "Creando instancia…" : "Creando instancia", async () => {
    persistSettingsFromForm();
    const customProfile = el.newCustomProfile.value.trim();
    const minecraftVersion = customProfile || el.newVersionList.value;
    if (!minecraftVersion) throw new Error("Elige una versión de Minecraft en la lista.");
    const loaderUid = customProfile ? "" : el.newLoaderList.value;
    const loaderVersion = el.newLoaderVersionList.value;
    if (loaderUid && !loaderVersion) throw new Error(`Elige una versión de ${describeComponent(loaderUid)} en la lista.`);

    const resolved = loaderUid ? await prismMeta.resolveLoader(loaderUid, loaderVersion, minecraftVersion) : null;
    const name = el.newName.value.trim() || suggestedInstanceName();
    let instance = await createInstance({ name, minecraftVersion, backend: "auto" });
    if (resolved) {
      instance = await installInstanceComponents(instance.id, resolvedToInstalls(resolved), allLoaderUids());
      log(`${describeComponent(loaderUid)} ${loaderVersion} añadido a la instancia desde Prism Meta.`, "ok");
    }
    lastResolved = null;
    lastPlan = null;
    lastResolvedInstanceId = null;
    await refreshInstances(instance.id);
    closeDialog(el.newDialog);
    log(`Instancia «${instance.name}» creada (Prism: instance.cfg + mmc-pack.json).`, "ok");
    pendingLaunchAfterCreate = startAfter;
  });
  if (pendingLaunchAfterCreate) {
    pendingLaunchAfterCreate = false;
    launchSelected();
  }
}

function openChangeVersionDialog(): void {
  if (!selectedInstance) return openNewInstanceDialog();
  fillVersionList(el.changeVersionList, "change", selectedInstance.minecraftVersion);
  updateChangeSummary();
  showDialog(el.changeDialog);
}

function openLoaderDialog(): void {
  if (!selectedInstance) return openNewInstanceDialog();
  const current = primaryLoaderComponent(selectedInstance.components);
  el.loaderContext.innerHTML = `<strong>${escapeHtml(selectedInstance.name)}</strong> · Minecraft ${escapeHtml(selectedInstance.minecraftVersion)} · Loader actual: <strong>${escapeHtml(loaderSummary(selectedInstance))}</strong>.<br />Elige loader y versión. Si eliges otro, el anterior se sustituye.`;
  fillLoaderList(el.loaderList, selectedInstance.minecraftVersion, current?.uid ?? "");
  showDialog(el.loaderDialog);
  void refreshLoaderVersions("dialog");
}

async function removeLoaderFromSelected(): Promise<void> {
  const instance = requireSelected();
  const updated = await removeInstanceComponents(instance.id, allLoaderUids());
  selectedInstance = updated;
  lastResolved = null;
  lastPlan = null;
  await refreshInstances(updated.id);
  log("Mod loader eliminado; la instancia queda en vanilla.", "ok");
}

/* Resources -------------------------------------------------------------- */

function updateLocalDetection(message: string): void {
  document.querySelectorAll<HTMLElement>(".local-detection").forEach((item) => {
    item.textContent = message;
  });
}

function currentResource(): InstalledResource | null {
  return currentResources.find((resource) => resource.fileName === selectedResourceName) ?? null;
}

function resourceContextText(instance: InstanceSummary, kind: ResourceKind, context: ModrinthContext): string {
  if (kind === "mods") {
    return context.loaderSlugs.length
      ? `<strong>Descarga rápida preparada:</strong> Modrinth filtrará por Minecraft ${escapeHtml(context.minecraftVersion)} + ${escapeHtml(context.loaderSlugs.join(" / "))}. Instala solo mods de ese loader.`
      : `<strong>Falta el loader:</strong> esta instancia es vanilla o su perfil no declara loader. Ve a Versión → “Instalar / cambiar loader…” antes de descargar mods.`;
  }
  if (kind === "shaderpacks") {
    return `<strong>Shaders:</strong> se guardan en <code>shaderpacks/</code>. Para verlos en el juego normalmente necesitas OptiFine/Iris/Oculus compatible como mod; WebPrism solo instala el pack.`;
  }
  if (kind === "datapacks") {
    return `<strong>Paquetes de datos:</strong> elige arriba si van a la carpeta global de Prism o dentro de un mundo concreto. En vanilla, los de mundo son los que carga la partida.`;
  }
  return `<strong>Paquetes de recursos:</strong> se guardan en <code>resourcepacks/</code> y se activan dentro de Minecraft en Opciones → Paquetes de recursos.`;
}

async function refreshResourcePage(preserveTarget = true): Promise<void> {
  const instance = selectedInstance;
  const definition = RESOURCE_DEFINITIONS[currentResourceKind];
  el.resourceTitle.textContent = definition.label;
  if (!instance) {
    el.resourcePath.textContent = "Sin instancia.";
    el.resourcesList.innerHTML = `<div class="empty-list">Crea o selecciona una instancia.</div>`;
    return;
  }
  const previousTargetId = preserveTarget ? currentResourceTarget?.id : undefined;
  currentResourceTargets = await listResourceTargets(instance, currentResourceKind);
  currentResourceTarget = currentResourceTargets.find((target) => target.id === previousTargetId) ?? currentResourceTargets[0] ?? null;
  el.resourceTarget.replaceChildren(
    ...currentResourceTargets.map((target) => {
      const option = document.createElement("option");
      option.value = target.id;
      option.textContent = target.label;
      return option;
    }),
  );
  if (currentResourceTarget) el.resourceTarget.value = currentResourceTarget.id;
  el.resourceTarget.disabled = currentResourceTargets.length <= 1;
  el.resourcePath.textContent = currentResourceTarget?.displayPath ?? "";
  el.resourceContext.innerHTML = resourceContextText(instance, currentResourceKind, modrinthContextForInstance(instance));
  element<HTMLInputElement>("resource-file-input").accept = definition.accept;

  currentResources = currentResourceTarget ? await listInstalledResources(instance, currentResourceKind, currentResourceTarget) : [];
  if (selectedResourceName && !currentResources.some((resource) => resource.fileName === selectedResourceName)) {
    selectedResourceName = currentResources[0]?.fileName ?? null;
  }
  if (!selectedResourceName) selectedResourceName = currentResources[0]?.fileName ?? null;
  renderResources();
}

function renderResources(): void {
  const query = el.resourceSearch.value.trim().toLowerCase();
  const visible = currentResources.filter((resource) => !query || `${resource.displayName} ${resource.metadata?.projectTitle ?? ""}`.toLowerCase().includes(query));
  el.resourcesList.replaceChildren();
  if (!visible.length) {
    const empty = document.createElement("div");
    empty.className = "empty-list";
    empty.innerHTML = currentResources.length
      ? "Ningún archivo coincide con la búsqueda."
      : `Todavía no hay nada aquí.<br /><strong>Descargar…</strong> instala desde Modrinth o <strong>Añadir archivo…</strong> copia un archivo de tu ordenador.`;
    el.resourcesList.appendChild(empty);
  }
  for (const resource of visible) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `resource-row${resource.fileName === selectedResourceName ? " selected" : ""}${resource.enabled ? "" : " disabled"}`;
    row.dataset.fileName = resource.fileName;
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(resource.fileName === selectedResourceName));
    row.innerHTML = `
      <span>${resource.enabled ? "☑ Activado" : "☐ Desactivado"}</span>
      <span class="filename" title="${escapeHtml(resource.fileName)}">${escapeHtml(resource.displayName)}${resource.entryKind === "directory" ? " /" : ""}</span>
      <span>${resource.size !== undefined ? escapeHtml(formatBytes(resource.size)) : "carpeta"}</span>
      <span>${resource.lastModified ? escapeHtml(new Date(resource.lastModified).toLocaleDateString("es-ES")) : "—"}</span>
      <span>${resource.metadata?.provider === "modrinth" ? "Modrinth" : "Local"}</span>`;
    row.addEventListener("click", () => {
      selectedResourceName = resource.fileName;
      renderResources();
    });
    row.addEventListener("dblclick", () => {
      selectedResourceName = resource.fileName;
      void toggleCurrentResource();
    });
    el.resourcesList.appendChild(row);
  }
  renderResourceDetails();
}

function renderResourceDetails(): void {
  const resource = currentResource();
  el.toggleResource.disabled = !resource || resource.entryKind !== "file" || resourceBusy;
  el.toggleResource.textContent = resource?.enabled ? "Desactivar" : "Activar";
  element<HTMLButtonElement>("delete-resource").disabled = !resource || resourceBusy;
  if (!resource) {
    el.resourceDetails.textContent = "Selecciona un archivo de la lista. “Desactivar” añade .disabled, como hace Prism.";
    return;
  }
  const metadata = resource.metadata;
  el.resourceDetails.innerHTML = metadata?.provider === "modrinth"
    ? `<strong>${escapeHtml(metadata.projectTitle ?? resource.displayName)}</strong>${metadata.versionNumber ? ` · versión ${escapeHtml(metadata.versionNumber)}` : ""}<br />Archivo: <code>${escapeHtml(resource.fileName)}</code> · instalado desde Modrinth el ${escapeHtml(new Date(metadata.installedAt).toLocaleString("es-ES"))}.`
    : `<strong>${escapeHtml(resource.displayName)}</strong><br />Archivo local en <code>${escapeHtml(resource.target.displayPath)}</code>. ${resource.enabled ? "Está activado." : "Está desactivado con .disabled."}`;
}

async function runResourceOperation(label: string, operation: () => Promise<void>): Promise<void> {
  if (busy || resourceBusy) {
    log("Espera a que termine la tarea actual.", "warn");
    return;
  }
  if (isGameRunning() || aotRunning) {
    log("No cambies mods/packs mientras el juego está abierto en esta pestaña.", "warn");
    return;
  }
  resourceBusy = true;
  el.progressLabel.textContent = label;
  el.progressDetail.textContent = "Trabajando…";
  renderResourceDetails();
  try {
    await operation();
    await refreshInstances(selectedInstance?.id);
    await refreshResourcePage();
  } catch (error) {
    log(error instanceof Error ? error.message : String(error), "error");
  } finally {
    resourceBusy = false;
    setProgress(null);
    renderResourceDetails();
    void updateStorageEstimate();
  }
}

async function toggleCurrentResource(): Promise<void> {
  const instance = selectedInstance;
  const resource = currentResource();
  if (!instance || !resource) return;
  await runResourceOperation(resource.enabled ? "Desactivando…" : "Activando…", async () => {
    const updated = await setInstalledResourceEnabled(instance, resource, !resource.enabled);
    selectedResourceName = updated.fileName;
    log(`${updated.displayName} ${updated.enabled ? "activado" : "desactivado"}.`, "ok");
  });
}

async function renderWorlds(): Promise<void> {
  const instance = selectedInstance;
  el.worldsList.replaceChildren();
  if (!instance) return;
  const worlds = await listWorldNames(instance);
  if (!worlds.length) {
    el.worldsList.innerHTML = `<div class="empty-list">Aún no hay mundos en saves/. Aparecerán tras jugar o importar una instancia.</div>`;
    return;
  }
  for (const world of worlds) {
    const row = document.createElement("div");
    row.className = "simple-row";
    row.innerHTML = `<span>◎</span><strong>${escapeHtml(world)}</strong><span class="row-muted">saves/${escapeHtml(world)}/</span>`;
    el.worldsList.appendChild(row);
  }
}

/* Modrinth --------------------------------------------------------------- */

function compactNumber(value?: number): string {
  if (!value) return "0";
  return new Intl.NumberFormat("es-ES", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function openDownloadDialog(): void {
  const instance = selectedInstance;
  if (!instance || !currentResourceTarget) {
    log("Selecciona una instancia y una carpeta destino primero.", "warn");
    return;
  }
  const definition = RESOURCE_DEFINITIONS[currentResourceKind];
  const context = modrinthContextForInstance(instance);
  downloadState.canInstall = currentResourceKind !== "mods" || context.loaderSlugs.length > 0;
  el.downloadTitle.textContent = `Descargar ${definition.label.toLowerCase()} desde Modrinth`;
  el.downloadContext.innerHTML = `Destino: <code>${escapeHtml(currentResourceTarget.displayPath)}</code><br />Filtro: Minecraft <strong>${escapeHtml(context.minecraftVersion)}</strong>${currentResourceKind === "mods" ? ` · Loader: <strong>${escapeHtml(context.loaderSlugs.join(" / ") || "ninguno detectado")}</strong>` : ""}.${downloadState.canInstall ? "" : "<br /><strong>Instala primero un loader</strong> en Versión para no descargar mods incompatibles."}`;
  el.installDownloadVersion.disabled = !downloadState.canInstall;
  showDialog(el.downloadDialog);
  void searchDownloads(false);
}

async function searchDownloads(append: boolean): Promise<void> {
  const instance = selectedInstance;
  if (!instance) return;
  const token = ++downloadState.searchToken;
  const context = modrinthContextForInstance(instance);
  const offset = append ? downloadState.hits.length : 0;
  el.downloadStatus.textContent = append ? "Cargando más resultados…" : "Buscando en Modrinth…";
  if (!append) {
    el.downloadResults.innerHTML = `<div class="empty-list">Buscando…</div>`;
    el.downloadVersionList.replaceChildren();
    downloadState.versions = [];
    downloadState.selectedHit = null;
  }
  try {
    const result = await modrinth.search(currentResourceKind, context, el.downloadSearch.value, el.downloadSort.value, offset);
    if (token !== downloadState.searchToken) return;
    downloadState.hits = append ? [...downloadState.hits, ...result.hits] : result.hits;
    downloadState.total = result.total;
    el.downloadMore.disabled = downloadState.hits.length >= downloadState.total || !result.hits.length;
    el.downloadStatus.textContent = `${downloadState.hits.length} de ${downloadState.total} resultado(s) para Minecraft ${context.minecraftVersion}.`;
    renderDownloadResults();
    const first = downloadState.hits[offset] ?? downloadState.hits[0];
    if (!append && first) await selectDownloadHit(first);
    if (!downloadState.hits.length) {
      el.downloadVersionDetails.textContent = "Sin resultados compatibles. Prueba otro texto o revisa versión/loader de la instancia.";
    }
  } catch (error) {
    if (token !== downloadState.searchToken) return;
    el.downloadResults.innerHTML = `<div class="empty-list">No se pudo buscar en Modrinth.</div>`;
    el.downloadStatus.textContent = friendlyNetworkError(error, "Modrinth");
    log(`Modrinth: ${error instanceof Error ? error.message : String(error)}`, "warn");
  }
}

function renderDownloadResults(): void {
  const installedIds = new Set(currentResources.map((resource) => resource.metadata?.projectId).filter(Boolean));
  el.downloadResults.replaceChildren();
  if (!downloadState.hits.length) {
    el.downloadResults.innerHTML = `<div class="empty-list">Sin resultados. Prueba con otro nombre.</div>`;
    return;
  }
  downloadState.hits.forEach((hit, index) => {
    const row = document.createElement("div");
    row.className = `download-row${hit.project_id === downloadState.selectedHit?.project_id ? " selected" : ""}`;
    row.dataset.index = String(index);
    const installed = installedIds.has(hit.project_id);
    row.innerHTML = `
      ${hit.icon_url ? `<img src="${escapeHtml(hit.icon_url)}" alt="" loading="lazy" />` : `<span class="row-icon">◆</span>`}
      <span><span class="project-title">${escapeHtml(hit.title)}</span><span class="project-desc">${escapeHtml(hit.description ?? "")}</span></span>
      <span>${escapeHtml(hit.author ?? "—")}</span>
      <span>${escapeHtml(compactNumber(hit.downloads))}</span>
      <span>${installed ? `<span class="installed-badge">Instalado</span>` : `<button type="button" class="qt-button" data-quick-install="${index}" ${downloadState.canInstall ? "" : "disabled"}>Instalar</button>`}</span>`;
    row.addEventListener("click", (event) => {
      if ((event.target as HTMLElement).closest("button")) return;
      void selectDownloadHit(hit);
    });
    el.downloadResults.appendChild(row);
  });
}

async function selectDownloadHit(hit: ModrinthSearchHit): Promise<void> {
  const instance = selectedInstance;
  if (!instance) return;
  const token = ++downloadState.versionToken;
  downloadState.selectedHit = hit;
  renderDownloadResults();
  el.downloadVersionList.replaceChildren(new Option("Cargando versiones…", ""));
  el.downloadVersionDetails.textContent = `Buscando archivos de ${hit.title} para esta instancia…`;
  try {
    const versions = await modrinth.listVersions(hit.project_id, currentResourceKind, modrinthContextForInstance(instance));
    if (token !== downloadState.versionToken) return;
    downloadState.versions = versions;
    el.downloadVersionList.replaceChildren(
      ...versions.map((version) => {
        const file = version.files.find((candidate) => candidate.primary) ?? version.files[0];
        const option = document.createElement("option");
        option.value = version.id;
        option.textContent = `${version.version_number} · ${version.version_type}${version.featured ? " ★" : ""} · ${file?.filename ?? "sin archivo"}`;
        return option;
      }),
    );
    if (versions.length) el.downloadVersionList.value = versions[0].id;
    renderDownloadVersionDetails();
  } catch (error) {
    if (token !== downloadState.versionToken) return;
    el.downloadVersionDetails.textContent = friendlyNetworkError(error, "Modrinth");
    log(`Modrinth versiones: ${error instanceof Error ? error.message : String(error)}`, "warn");
  }
}

function selectedDownloadVersion(): ModrinthVersion | undefined {
  return downloadState.versions.find((version) => version.id === el.downloadVersionList.value);
}

function renderDownloadVersionDetails(): void {
  const hit = downloadState.selectedHit;
  const version = selectedDownloadVersion();
  el.installDownloadVersion.disabled = !downloadState.canInstall || !version || resourceBusy;
  if (!hit) {
    el.downloadVersionDetails.textContent = "Elige un proyecto para ver sus versiones.";
    return;
  }
  if (!version) {
    el.downloadVersionDetails.innerHTML = `<strong>${escapeHtml(hit.title)}</strong><br />No hay archivos compatibles con esta instancia.`;
    return;
  }
  const file = version.files.find((candidate) => candidate.primary) ?? version.files[0];
  const required = (version.dependencies ?? []).filter((dependency) => dependency.dependency_type === "required" && dependency.project_id).length;
  el.downloadVersionDetails.innerHTML = `<strong>${escapeHtml(hit.title)} ${escapeHtml(version.version_number)}</strong><br />Archivo: <code>${escapeHtml(file?.filename ?? "—")}</code>${file ? ` · ${escapeHtml(formatBytes(file.size))}` : ""}<br />Minecraft: ${escapeHtml(version.game_versions.join(", ") || "—")} · Loaders: ${escapeHtml(version.loaders.join(", ") || "—")}${required ? `<br />También se instalarán ${required} dependencia(s) requerida(s).` : ""}`;
}

async function installFromModrinth(hit: ModrinthSearchHit, version?: ModrinthVersion): Promise<void> {
  const instance = selectedInstance;
  const target = currentResourceTarget;
  if (!instance || !target) return;
  if (!downloadState.canInstall) {
    log("Instala un mod loader antes de descargar mods para evitar archivos incompatibles.", "warn");
    return;
  }
  await runResourceOperation(`Instalando ${hit.title}…`, async () => {
    const context = modrinthContextForInstance(instance);
    const installed = version
      ? await modrinth.installVersion(
          instance,
          currentResourceKind,
          target,
          { id: hit.project_id, slug: hit.slug, title: hit.title, project_type: hit.project_type },
          version,
          context,
          setProgress,
        )
      : await modrinth.installPreferred(instance, currentResourceKind, target, hit, context, setProgress);
    selectedResourceName = installed.find((resource) => resource.kind === currentResourceKind)?.fileName ?? installed[0]?.fileName ?? selectedResourceName;
    el.downloadStatus.textContent = `${hit.title} instalado en ${target.displayPath}.`;
  });
  renderDownloadResults();
  renderDownloadVersionDetails();
}

/* Local folders ---------------------------------------------------------- */

async function refreshLocalFolderState(): Promise<void> {
  try {
    const dir = await getSharedCacheDir(false);
    if (!dir) {
      updateLocalDetection("No has elegido ninguna carpeta local. Puedes usar tu .minecraft o la carpeta de Prism como caché.");
      return;
    }
    const detection = await detectLocalFolder(dir);
    updateLocalDetection(`Carpeta local enlazada (${dir.name}): ${detection.summary}`);
  } catch {
    updateLocalDetection("Hay una carpeta local guardada, pero el navegador aún no tiene permiso para leerla en esta carga.");
  }
}

function chooseImportedVersion(versionIds: string[]): Promise<string | null> {
  if (versionIds.length <= 1) return Promise.resolve(versionIds[0] ?? "1.12.2");
  el.importVersionList.replaceChildren(
    ...versionIds.map((id) => {
      const option = document.createElement("option");
      option.value = id;
      const optionInfo = versionOptions.find((candidate) => candidate.id === id);
      option.textContent = `${id} · ${optionInfo ? versionTypeLabel(optionInfo) : "perfil local"} · ${quickVersionWebStatus(id).label}`;
      return option;
    }),
  );
  el.importVersionList.selectedIndex = 0;
  return new Promise((resolve) => {
    importVersionResolver = resolve;
    showDialog(el.importVersionDialog);
  });
}

function resolveImportVersion(version: string | null): void {
  const resolve = importVersionResolver;
  importVersionResolver = null;
  closeDialog(el.importVersionDialog);
  resolve?.(version);
}

async function importPrismFlow(): Promise<void> {
  const dir = await pickDirectory("read");
  const detection = await detectLocalFolder(dir);
  updateLocalDetection(detection.summary);
  if (detection.kind === "prism-instance") {
    const id = await importPrismInstance(dir, setProgress, log);
    await refreshInstances(id);
  } else if (detection.kind === "prism-instances-root") {
    const ids = await importPrismInstancesRoot(dir, setProgress, log);
    if (!ids.length) throw new Error("No se pudo importar ninguna instancia de esa carpeta.");
    await refreshInstances(ids[0]);
    log(`Importadas ${ids.length} instancia(s) de Prism.`, "ok");
  } else {
    throw new Error(`La carpeta no parece una instancia Prism ni la carpeta raíz de instancias. ${detection.summary}`);
  }
  lastResolved = null;
  lastPlan = null;
  closeDialog(el.newDialog);
}

async function importMinecraftFlow(): Promise<void> {
  const dir = await pickDirectory("read");
  const detection = await detectLocalFolder(dir);
  updateLocalDetection(detection.summary);
  if (detection.kind !== "minecraft" && detection.kind !== "shared-cache") {
    throw new Error(`Selecciona una carpeta .minecraft o datos con versions/libraries/assets. ${detection.summary}`);
  }
  const version = await chooseImportedVersion(detection.versionIds);
  if (!version) {
    log("Importación de .minecraft cancelada al elegir perfil.", "warn");
    return;
  }
  const id = await importMinecraftFolderAsInstance(dir, version, setProgress, log);
  await refreshInstances(id);
  await loadVersions(false);
  lastResolved = null;
  lastPlan = null;
  closeDialog(el.newDialog);
}

async function linkCacheFlow(): Promise<void> {
  const dir = await pickDirectory("read");
  const detection = await linkSharedCache(dir);
  updateLocalDetection(detection.summary);
  if (detection.kind === "unknown") {
    log("La carpeta quedó enlazada, pero no parece contener versions + libraries/assets; se descargará lo que falte de Mojang.", "warn");
  } else {
    log(`Caché local enlazada: ${detection.summary}`, "ok");
  }
  await loadVersions(false);
}

async function exportSelectedFlow(): Promise<void> {
  if (!selectedInstance) throw new Error("Selecciona una instancia primero.");
  if (isGameRunning() || aotRunning) throw new Error("Espera a que termine el juego antes de exportar; si no, los mundos pueden quedar a medias.");
  const instance = selectedInstance;
  if (instance.sidecar.linkedLocalKind === "minecraft") {
    const target = (await getInstanceDirHandle(instance.id, "readwrite", true)) ?? (await pickDirectory("readwrite"));
    await exportMinecraftGameDirToLocal(instance.id, instance.gameDirName, target, setProgress, log);
    return;
  }
  let target = await getInstanceDirHandle(instance.id, "readwrite", true);
  if (!target) {
    target = await pickDirectory("readwrite");
    const detection = await detectLocalFolder(target);
    if (detection.kind === "prism-instances-root") {
      const child = await localChildDir(target, instance.id, { create: true });
      if (!child) throw new Error("No se pudo crear la subcarpeta de la instancia dentro de la carpeta raíz elegida.");
      target = child;
      log(`La carpeta elegida es una raíz de instancias Prism; se exportará dentro de ${instance.id}/.`);
    }
  }
  await exportInstanceToLocal(instance.id, target, setProgress, log);
  await updateInstanceSidecar(instance.id, { linkedLocalKind: "prism-instance", linkedLocalName: target.name });
  await refreshInstances(instance.id);
}

/* Launching -------------------------------------------------------------- */

function aotUrlFromFormOrInstance(instance: InstanceSummary | null): string {
  const formValue = el.aotUrl.value.trim();
  if (formValue && instance?.id === selectedInstance?.id) return formValue;
  if (!instance) return "";
  return instance.sidecar.aotUrl ?? settings.aotUrls[instance.minecraftVersion] ?? "";
}

async function persistSelectedInstanceSettings(): Promise<InstanceSummary> {
  const instance = requireSelected();
  persistSettingsFromForm();
  const aotUrl = el.aotUrl.value.trim();
  const updated = await updateInstanceSidecar(instance.id, {
    backend: el.backendSelect.value as BackendId,
    windowWidth: Math.max(320, Number.parseInt(el.windowWidth.value, 10) || 854),
    windowHeight: Math.max(200, Number.parseInt(el.windowHeight.value, 10) || 480),
    aotUrl: aotUrl || undefined,
  });
  if (aotUrl && updated.minecraftVersion) {
    settings = { ...settings, aotUrls: { ...settings.aotUrls, [updated.minecraftVersion]: aotUrl } };
    saveSettings();
  }
  selectedInstance = updated;
  instances = instances.map((candidate) => (candidate.id === updated.id ? updated : candidate));
  renderInstanceList();
  renderSelected();
  return updated;
}

function validatePlayInputs(instance: InstanceSummary): void {
  const username = el.username.value.trim();
  if (!isValidOfflineUsername(username)) {
    throw new Error("El nombre de usuario offline debe tener 3–16 caracteres: letras, números o guion bajo.");
  }
  if (!el.eula.checked) throw new Error("Acepta el EULA de Minecraft antes de descargar o ejecutar el juego.");
  if (!instance.minecraftVersion) throw new Error("La instancia no tiene versión de Minecraft en mmc-pack.json.");
}

function effectiveBackend(instance: InstanceSummary): "cheerpj" | "aot" {
  const requested = instance.sidecar.backend;
  if (requested === "cheerpj" || requested === "aot") return requested;
  const hasLoaderOrMods = instance.modCount > 0 || instance.components.some((component) => !component.disabled && isLoaderComponent(component.uid));
  return aotUrlFromFormOrInstance(instance) && !hasLoaderOrMods ? "aot" : "cheerpj";
}

function setGameStatus(text: string, state: "ok" | "warn" | "bad" | ""): void {
  el.gameStatus.textContent = text;
  el.gameStatus.className = `status-pill ${state}`;
}

async function playAot(instance: InstanceSummary): Promise<void> {
  const rawUrl = aotUrlFromFormOrInstance(instance);
  if (!rawUrl) {
    throw new Error("El backend AOT necesita la URL de un bundle TeaVM/Eagler que tú alojes. WebPrism no incluye ese cliente por licencia/distribución.");
  }
  const url = new URL(rawUrl, window.location.href);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("La URL AOT debe ser http(s).");
  showEdit("game");
  el.gameDisplay.hidden = true;
  el.aotFrame.hidden = false;
  el.aotFrame.src = "about:blank";
  requestAnimationFrame(() => {
    el.aotFrame.src = url.toString();
  });
  aotRunning = true;
  setGameStatus("AOT cargado", "ok");
  const now = Date.now();
  await touchInstanceLaunchTimes(instance.id, now, now);
  await refreshInstances(instance.id);
  log(`Bundle AOT cargado desde ${url.toString()}. El nombre de usuario se configura dentro del bundle si no acepta parámetros.`, "ok");
}

async function playCheerpj(instance: InstanceSummary): Promise<void> {
  if (!serviceWorkerControlled) {
    throw new Error("El Service Worker aún no controla la página, así que CheerpJ no puede leer OPFS por /app/webprism-data. Recarga la página y vuelve a intentarlo.");
  }
  if (isGameRunning()) throw new Error("Ya hay una JVM en marcha en esta pestaña.");

  const resolved = await service.resolveInstance(instance);
  lastResolved = resolved;
  lastResolvedInstanceId = instance.id;
  lastPlan = null;
  renderPlanDetails();
  renderInstanceList();
  renderLaunchReadiness();
  if (resolved.compatibility.status === "blocked") {
    showEdit("version");
    throw new Error(`No se puede ejecutar todavía en web: ${resolved.compatibility.blockers.join(" ")} La instancia sí puede gestionarse y exportarse a Prism.`);
  }

  const plan = await service.prepareLaunchPlan(instance, {
    username: el.username.value.trim(),
    width: instance.sidecar.windowWidth,
    height: instance.sidecar.windowHeight,
    onProgress: setProgress,
  });
  lastPlan = plan;
  renderPlanDetails();

  showEdit("game");
  el.aotFrame.hidden = true;
  el.aotFrame.src = "about:blank";
  el.gameDisplay.hidden = false;
  el.gameDisplay.replaceChildren();
  setGameStatus("Iniciando JVM…", "warn");

  const startedAt = Date.now();
  try {
    await runCheerpjPlan(instance, plan, {
      loaderUrl: settings.cheerpjLoaderUrl,
      display: el.gameDisplay,
      onLog: log,
      onProgress: setProgress,
      onJvmSyncComplete: async (timestamp) => {
        selectedInstance = await updateInstanceSidecar(instance.id, { lastJvmSyncAt: timestamp });
      },
    });
    setGameStatus("JVM finalizada", "");
  } catch (error) {
    setGameStatus("JVM detenida con error", "bad");
    throw error;
  } finally {
    await touchInstanceLaunchTimes(instance.id, startedAt, Date.now()).catch(() => undefined);
    await refreshInstances(instance.id);
    if (currentView === "edit") await refreshCurrentEditData();
  }
}

function launchSelected(): void {
  closeMenus();
  if (!selectedInstance) {
    openNewInstanceDialog();
    return;
  }
  persistSettingsFromForm();
  const username = el.username.value.trim();
  if (!isValidOfflineUsername(username) || !el.eula.checked) {
    showDialog(element<HTMLDialogElement>("account-dialog"));
    log("Antes de jugar: escribe un nombre offline válido y acepta el EULA. Pulsa Guardar cuenta y luego Iniciar otra vez.", "warn");
    return;
  }
  void runTask("Iniciando…", async () => {
    const instance = await persistSelectedInstanceSettings();
    validatePlayInputs(instance);
    if (instance.sidecar.backend === "manage") {
      lastResolved = await service.resolveInstance(instance);
      lastResolvedInstanceId = instance.id;
      lastPlan = await service.prepareLaunchPlan(instance, {
        username,
        width: instance.sidecar.windowWidth,
        height: instance.sidecar.windowHeight,
        onProgress: setProgress,
      });
      renderPlanDetails();
      showEdit("version");
      log("Esta instancia está en modo “solo gestionar/exportar”: archivos comprobados, pero no se inicia el juego.", "warn");
      return;
    }
    const backend = effectiveBackend(instance);
    log(`Backend efectivo: ${backend === "aot" ? "AOT/TeaVM" : "CheerpJ (JVM real)"}.`);
    if (backend === "aot") await playAot(instance);
    else await playCheerpj(instance);
  });
}

async function resolveSelected(): Promise<void> {
  const instance = await persistSelectedInstanceSettings();
  lastResolved = await service.resolveInstance(instance);
  lastResolvedInstanceId = instance.id;
  lastPlan = null;
  renderPlanDetails();
  renderInstanceList();
  renderLaunchReadiness();
  log(`Perfil ${lastResolved.profile.id}: ${lastResolved.compatibility.title}.`, lastResolved.compatibility.status === "blocked" ? "warn" : "ok");
}

async function prepareSelected(): Promise<void> {
  const instance = await persistSelectedInstanceSettings();
  if (!el.eula.checked) throw new Error("Acepta el EULA antes de descargar archivos del juego.");
  lastResolved = await service.resolveInstance(instance);
  lastResolvedInstanceId = instance.id;
  if (lastResolved.compatibility.status === "blocked") {
    log("Este perfil no puede ejecutarse aún en web; se descargan/comprueban sus archivos porque lo has pedido explícitamente.", "warn");
  }
  lastPlan = await service.prepareLaunchPlan(instance, {
    username: el.username.value.trim() || "Steve",
    width: instance.sidecar.windowWidth,
    height: instance.sidecar.windowHeight,
    onProgress: setProgress,
  });
  renderPlanDetails();
  renderInstanceList();
  renderLaunchReadiness();
  log("Archivos del juego descargados y verificados en OPFS.", "ok");
}

/* Browser capabilities --------------------------------------------------- */

async function registerServiceWorker(): Promise<void> {
  if (!("serviceWorker" in navigator)) {
    setCapability("cap-sw", "missing", "Service Worker no soportado");
    return;
  }
  try {
    const swUrl = new URL("sw.js", window.location.href);
    await navigator.serviceWorker.register(swUrl, { scope: "/" });
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((resolve) => {
        const timeout = window.setTimeout(resolve, 3000);
        navigator.serviceWorker.addEventListener(
          "controllerchange",
          () => {
            window.clearTimeout(timeout);
            resolve();
          },
          { once: true },
        );
      });
    }
    serviceWorkerControlled = Boolean(navigator.serviceWorker.controller);
    setCapability("cap-sw", serviceWorkerControlled ? "ok" : "warn", serviceWorkerControlled ? "Service Worker activo" : "Service Worker: recarga una vez");
    if (!serviceWorkerControlled) log("El Service Worker se instaló, pero todavía no controla esta carga; recarga una vez antes de arrancar CheerpJ.", "warn");
  } catch (error) {
    setCapability("cap-sw", "missing", "Service Worker falló");
    log(`No se pudo registrar el Service Worker: ${error instanceof Error ? error.message : String(error)}`, "error");
  }
}

async function checkCapabilities(): Promise<void> {
  try {
    await opfs.ensureDir("cache");
    const persistent = await opfs.requestPersistence();
    setCapability("cap-opfs", "ok", persistent ? "OPFS persistente" : "OPFS activo");
  } catch (error) {
    setCapability("cap-opfs", "missing", "OPFS no disponible");
    log(error instanceof Error ? error.message : String(error), "error");
  }
  const fsSupported = supportsDirectoryPicker();
  setCapability("cap-fs", fsSupported ? "ok" : "warn", fsSupported ? "Carpetas locales sí" : "Carpetas locales: Chromium");
  setCapability("cap-wasm", typeof WebAssembly === "object" ? "ok" : "missing", typeof WebAssembly === "object" ? "WebAssembly activo" : "Sin WebAssembly");
  const canvas = document.createElement("canvas");
  const webgl2 = Boolean(canvas.getContext("webgl2"));
  setCapability("cap-webgl", webgl2 ? "ok" : "warn", webgl2 ? "WebGL2 activo" : "WebGL2 no detectado");
  const runtime = await checkLwjgl2Runtime().catch(() => ({ ok: false, missing: ["runtime"] }));
  if (!runtime.ok) log("Falta el runtime LWJGL2 wasm en /lwjgl. En el despliegue ejecuta `npm run setup:runtime` (no se versiona en Git).", "warn");
}

/* Actions/events --------------------------------------------------------- */

function handleMenuAction(action: string): void {
  closeMenus();
  switch (action) {
    case "new-instance":
      openNewInstanceDialog();
      break;
    case "import-instance":
      void runTask("Importando Prism", importPrismFlow);
      break;
    case "import-minecraft":
      void runTask("Importando .minecraft", importMinecraftFlow);
      break;
    case "export-instance":
      void runTask("Exportando a disco", exportSelectedFlow);
      break;
    case "refresh":
      void runTask("Actualizando listas", async () => {
        persistSettingsFromForm();
        await loadVersions(true);
        await refreshInstances();
        await refreshLocalFolderState();
        if (currentView === "edit") await refreshCurrentEditData();
      });
      break;
    case "edit-instance":
      showEdit("version");
      break;
    case "install-loader":
      openLoaderDialog();
      break;
    case "rename-instance":
      void renameSelected();
      break;
    case "delete-instance":
      void deleteSelected();
      break;
    case "show-home":
      showHome();
      break;
    case "show-game":
      showEdit("game");
      break;
    case "show-log":
      showEdit("log");
      break;
    case "global-settings":
      showDialog(element<HTMLDialogElement>("settings-dialog"));
      break;
    case "link-cache":
      void runTask("Enlazando carpeta local", linkCacheFlow);
      break;
    case "help":
      showDialog(element<HTMLDialogElement>("help-dialog"));
      break;
  }
}

async function renameSelected(): Promise<void> {
  if (!selectedInstance) return openNewInstanceDialog();
  const name = window.prompt("Nuevo nombre visible (no cambia el ID de carpeta):", selectedInstance.name)?.trim();
  if (!name) return;
  await runTask("Renombrando instancia", async () => {
    selectedInstance = await renameInstance(requireSelected(), name);
    await refreshInstances(selectedInstance.id);
    log(`Instancia renombrada a «${name}».`, "ok");
  });
}

async function deleteSelected(): Promise<void> {
  if (!selectedInstance) return;
  const confirmed = window.confirm(`¿Eliminar «${selectedInstance.name}» de OPFS? Esto borra mundos y mods de la copia web, no tu carpeta local.`);
  if (!confirmed) return;
  await runTask("Eliminando instancia", async () => {
    await deleteInstance(requireSelected().id);
    selectedInstance = null;
    lastResolved = null;
    lastPlan = null;
    await refreshInstances();
    showHome();
    log("Instancia eliminada de OPFS.", "ok");
  });
}

function onNewMinecraftChanged(): void {
  const minecraftVersion = el.newCustomProfile.value.trim() || el.newVersionList.value;
  fillLoaderList(el.newLoaderList, minecraftVersion, el.newLoaderList.value);
  updateNewSummary();
  if (!el.newCustomProfile.value.trim()) void refreshLoaderVersions("new");
}

let downloadSearchTimer: number | undefined;

function bindEvents(): void {
  document.querySelectorAll<HTMLButtonElement>("[data-action]").forEach((button) => {
    button.addEventListener("click", () => handleMenuAction(button.dataset.action ?? ""));
  });
  document.querySelectorAll<HTMLButtonElement>("[data-close-dialog]").forEach((button) => {
    button.addEventListener("click", () => closeDialog(element<HTMLDialogElement>(button.dataset.closeDialog ?? "")));
  });
  document.addEventListener("click", (event) => {
    if (!(event.target as HTMLElement).closest("details.menu")) closeMenus();
  });

  element<HTMLButtonElement>("add-instance").addEventListener("click", openNewInstanceDialog);
  element<HTMLButtonElement>("folders-toolbar").addEventListener("click", () => {
    const menu = element<HTMLDetailsElement>("menu-folders");
    const open = !menu.open;
    closeMenus();
    menu.open = open;
  });
  element<HTMLButtonElement>("global-settings-toolbar").addEventListener("click", () => showDialog(element<HTMLDialogElement>("settings-dialog")));
  element<HTMLButtonElement>("help-toolbar").addEventListener("click", () => showDialog(element<HTMLDialogElement>("help-dialog")));
  element<HTMLButtonElement>("account-button").addEventListener("click", () => showDialog(element<HTMLDialogElement>("account-dialog")));

  el.instanceSearch.addEventListener("input", renderInstanceList);
  el.instanceSort.addEventListener("change", renderInstanceList);
  element<HTMLButtonElement>("play").addEventListener("click", launchSelected);
  element<HTMLButtonElement>("edit-play").addEventListener("click", launchSelected);
  element<HTMLButtonElement>("edit-instance").addEventListener("click", () => showEdit("version"));
  element<HTMLButtonElement>("install-loader-quick").addEventListener("click", openLoaderDialog);
  element<HTMLButtonElement>("export-instance-quick").addEventListener("click", () => void runTask("Exportando a disco", exportSelectedFlow));
  element<HTMLButtonElement>("rename-instance").addEventListener("click", () => void renameSelected());
  element<HTMLButtonElement>("delete-instance").addEventListener("click", () => void deleteSelected());
  document.querySelectorAll<HTMLButtonElement>("[data-edit-page]").forEach((button) => {
    button.addEventListener("click", () => showEdit(button.dataset.editPage as EditPage));
  });

  element<HTMLButtonElement>("back-home").addEventListener("click", showHome);
  element<HTMLButtonElement>("close-edit").addEventListener("click", showHome);
  document.querySelectorAll<HTMLButtonElement>(".page-link").forEach((button) => {
    button.addEventListener("click", () => setEditPage(button.dataset.page as EditPage));
  });
  element<HTMLButtonElement>("change-version").addEventListener("click", openChangeVersionDialog);
  element<HTMLButtonElement>("install-loader").addEventListener("click", openLoaderDialog);
  element<HTMLButtonElement>("remove-loader").addEventListener("click", () => void runTask("Quitando loader", removeLoaderFromSelected));
  el.componentsList.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target.closest("[data-install-loader]")) return openLoaderDialog();
    const removeButton = target.closest<HTMLButtonElement>("[data-remove-component]");
    if (!removeButton || !selectedInstance) return;
    const uid = removeButton.dataset.removeComponent ?? "";
    void runTask("Quitando componente", async () => {
      const instance = requireSelected();
      const uids = isLoaderComponent(uid) || uid === INTERMEDIARY_UID ? allLoaderUids() : [uid];
      selectedInstance = await removeInstanceComponents(instance.id, uids);
      lastResolved = null;
      lastPlan = null;
      await refreshInstances(selectedInstance.id);
      log(`${describeComponent(uid)} eliminado de mmc-pack.json.`, "ok");
    });
  });
  element<HTMLButtonElement>("resolve").addEventListener("click", () => void runTask("Comprobando compatibilidad", resolveSelected));
  element<HTMLButtonElement>("prepare").addEventListener("click", () => void runTask("Descargando archivos", prepareSelected));
  element<HTMLButtonElement>("save-instance-settings").addEventListener("click", () => {
    void runTask("Guardando instancia", async () => {
      await persistSelectedInstanceSettings();
      log("Ajustes de instancia guardados en webprism.json (Prism ignora ese archivo extra).", "ok");
    });
  });
  element<HTMLButtonElement>("open-account-from-settings").addEventListener("click", () => showDialog(element<HTMLDialogElement>("account-dialog")));
  element<HTMLButtonElement>("open-global-from-settings").addEventListener("click", () => showDialog(element<HTMLDialogElement>("settings-dialog")));
  element<HTMLButtonElement>("refresh-worlds").addEventListener("click", () => void renderWorlds());
  element<HTMLButtonElement>("fullscreen-game").addEventListener("click", () => {
    void el.gameStage.requestFullscreen?.().catch((error) => log(`Pantalla completa no disponible: ${error instanceof Error ? error.message : String(error)}`, "warn"));
  });
  element<HTMLButtonElement>("stop-game").addEventListener("click", () => window.location.reload());
  element<HTMLButtonElement>("clear-log").addEventListener("click", () => {
    el.log.value = "";
  });

  // New instance dialog
  el.newName.addEventListener("input", () => {
    newNameTouched = true;
  });
  el.newSourceList.addEventListener("change", () => setNewSource(el.newSourceList.value));
  element<HTMLButtonElement>("new-import-action").addEventListener("click", () => {
    if (el.newSourceList.value === "prism") void runTask("Importando Prism", importPrismFlow);
    else void runTask("Importando .minecraft", importMinecraftFlow);
  });
  element<HTMLButtonElement>("new-link-cache-action").addEventListener("click", () => void runTask("Enlazando carpeta local", linkCacheFlow));
  el.newQuickList.addEventListener("change", () => {
    const target = el.newQuickList.value === "latest" ? latestReleaseId : el.newQuickList.value;
    el.newVersionSearch.value = "";
    element<HTMLInputElement>("new-filter-release").checked = true;
    fillVersionList(el.newVersionList, "new", target);
    onNewMinecraftChanged();
  });
  for (const prefix of ["new", "change"] as const) {
    for (const filter of ["release", "snapshot", "beta", "alpha", "experiment", "local"]) {
      element<HTMLInputElement>(`${prefix}-filter-${filter}`).addEventListener("change", () => {
        if (prefix === "new") {
          fillVersionList(el.newVersionList, "new");
          onNewMinecraftChanged();
        } else {
          fillVersionList(el.changeVersionList, "change");
          updateChangeSummary();
        }
      });
    }
  }
  el.newVersionSearch.addEventListener("input", () => {
    fillVersionList(el.newVersionList, "new");
    onNewMinecraftChanged();
  });
  el.newVersionList.addEventListener("change", onNewMinecraftChanged);
  el.newVersionList.addEventListener("dblclick", () => void createCustomInstance(false));
  el.newCustomProfile.addEventListener("input", () => {
    if (el.newCustomProfile.value.trim()) {
      el.newLoaderList.value = "";
      fillNoLoaderVersion(el.newLoaderVersionList, el.newLoaderStatus);
    }
    updateNewSummary();
  });
  el.newLoaderList.addEventListener("change", () => void refreshLoaderVersions("new"));
  el.newLoaderVersionList.addEventListener("change", updateNewSummary);
  element<HTMLButtonElement>("new-loader-refresh").addEventListener("click", () => void refreshLoaderVersions("new", true));
  el.createInstance.addEventListener("click", () => void createCustomInstance(false));
  el.createAndPlay.addEventListener("click", () => void createCustomInstance(true));

  // Change version dialog
  el.changeVersionSearch.addEventListener("input", () => {
    fillVersionList(el.changeVersionList, "change");
    updateChangeSummary();
  });
  el.changeVersionList.addEventListener("change", updateChangeSummary);
  element<HTMLButtonElement>("apply-change-version").addEventListener("click", () => {
    void runTask("Cambiando versión", async () => {
      const instance = requireSelected();
      const version = el.changeVersionList.value;
      if (!version) throw new Error("Elige una versión en la lista.");
      const oldLoader = primaryLoaderComponent(instance.components);
      let updated = await updateInstanceVersion(instance, version);
      if (oldLoader) {
        const oldLoaderVersion = componentVersion(oldLoader);
        try {
          if (!oldLoaderVersion) throw new Error("el loader actual no declara versión");
          updated = await installLoaderIntoInstance(updated, oldLoader.uid, oldLoaderVersion);
          log(`Se mantuvo ${describeComponent(oldLoader.uid)} ${oldLoaderVersion} para Minecraft ${version}.`, "ok");
        } catch (error) {
          updated = await removeInstanceComponents(updated.id, allLoaderUids());
          log(`La versión cambió, pero ${describeComponent(oldLoader.uid)} ${oldLoaderVersion ?? ""} no sirve para Minecraft ${version}; se quitó el loader. Elige una versión compatible en Instalar loader. (${error instanceof Error ? error.message : String(error)})`, "warn");
        }
      }
      selectedInstance = updated;
      lastResolved = null;
      lastPlan = null;
      closeDialog(el.changeDialog);
      await refreshInstances(updated.id);
    });
  });

  // Loader dialog
  el.loaderList.addEventListener("change", () => void refreshLoaderVersions("dialog"));
  el.loaderVersionList.addEventListener("change", updateLoaderDialogState);
  element<HTMLButtonElement>("loader-refresh").addEventListener("click", () => void refreshLoaderVersions("dialog", true));
  element<HTMLButtonElement>("loader-apply").addEventListener("click", () => {
    void runTask("Instalando loader", async () => {
      const instance = requireSelected();
      const updated = await installLoaderIntoInstance(instance, el.loaderList.value, el.loaderVersionList.value);
      selectedInstance = updated;
      lastResolved = null;
      lastPlan = null;
      closeDialog(el.loaderDialog);
      await refreshInstances(updated.id);
    });
  });
  element<HTMLButtonElement>("loader-remove").addEventListener("click", () => {
    void runTask("Quitando loader", async () => {
      await removeLoaderFromSelected();
      closeDialog(el.loaderDialog);
    });
  });

  // Import version chooser
  element<HTMLButtonElement>("import-version-ok").addEventListener("click", () => resolveImportVersion(el.importVersionList.value || null));
  element<HTMLButtonElement>("import-version-cancel").addEventListener("click", () => resolveImportVersion(null));
  el.importVersionDialog.addEventListener("cancel", () => resolveImportVersion(null));

  // Resources
  el.resourceSearch.addEventListener("input", renderResources);
  el.resourceTarget.addEventListener("change", async () => {
    currentResourceTarget = currentResourceTargets.find((target) => target.id === el.resourceTarget.value) ?? currentResourceTargets[0] ?? null;
    selectedResourceName = null;
    if (!selectedInstance || !currentResourceTarget) return;
    el.resourcePath.textContent = currentResourceTarget.displayPath;
    currentResources = await listInstalledResources(selectedInstance, currentResourceKind, currentResourceTarget);
    selectedResourceName = currentResources[0]?.fileName ?? null;
    renderResources();
  });
  element<HTMLButtonElement>("download-resource").addEventListener("click", openDownloadDialog);
  element<HTMLButtonElement>("add-resource").addEventListener("click", () => el.resourceFileInput.click());
  el.resourceFileInput.addEventListener("change", async () => {
    const instance = selectedInstance;
    const target = currentResourceTarget;
    const files = [...(el.resourceFileInput.files ?? [])];
    el.resourceFileInput.value = "";
    if (!instance || !target || !files.length) return;
    await runResourceOperation("Añadiendo archivos…", async () => {
      const installed = await installLocalResourceFiles(instance, currentResourceKind, target, files);
      selectedResourceName = installed[0] ?? selectedResourceName;
      log(`${installed.length} archivo(s) añadidos a ${target.displayPath}: ${installed.join(", ")}.`, "ok");
    });
  });
  el.toggleResource.addEventListener("click", () => void toggleCurrentResource());
  element<HTMLButtonElement>("delete-resource").addEventListener("click", () => {
    const instance = selectedInstance;
    const resource = currentResource();
    if (!instance || !resource) return;
    if (!window.confirm(`¿Eliminar «${resource.displayName}» de la copia web (OPFS)?`)) return;
    void runResourceOperation("Eliminando…", async () => {
      await deleteInstalledResource(instance, resource);
      selectedResourceName = null;
      log(`${resource.displayName} eliminado de ${resource.target.displayPath}.`, "ok");
    });
  });
  element<HTMLButtonElement>("refresh-resources").addEventListener("click", () => void refreshResourcePage());

  // Modrinth dialog
  el.downloadSearch.addEventListener("input", () => {
    window.clearTimeout(downloadSearchTimer);
    downloadSearchTimer = window.setTimeout(() => void searchDownloads(false), 450);
  });
  el.downloadSearch.addEventListener("keydown", (event) => {
    if (event.key === "Enter") void searchDownloads(false);
  });
  element<HTMLButtonElement>("download-search-button").addEventListener("click", () => void searchDownloads(false));
  el.downloadSort.addEventListener("change", () => void searchDownloads(false));
  el.downloadMore.addEventListener("click", () => void searchDownloads(true));
  el.downloadVersionList.addEventListener("change", renderDownloadVersionDetails);
  el.downloadVersionList.addEventListener("dblclick", () => {
    if (downloadState.selectedHit && selectedDownloadVersion()) void installFromModrinth(downloadState.selectedHit, selectedDownloadVersion());
  });
  el.downloadResults.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-quick-install]");
    if (!button) return;
    const hit = downloadState.hits[Number(button.dataset.quickInstall)];
    if (hit) void installFromModrinth(hit);
  });
  el.installDownloadVersion.addEventListener("click", () => {
    if (downloadState.selectedHit) void installFromModrinth(downloadState.selectedHit, selectedDownloadVersion());
  });

  // Account/settings
  el.username.addEventListener("input", updateAccountPreview);
  el.eula.addEventListener("change", updateAccountPreview);
  element<HTMLButtonElement>("save-account").addEventListener("click", () => {
    const username = el.username.value.trim();
    if (!isValidOfflineUsername(username)) {
      log("El nombre offline debe tener 3–16 caracteres: letras, números o guion bajo.", "warn");
      el.username.focus();
      return;
    }
    persistSettingsFromForm();
    closeDialog(element<HTMLDialogElement>("account-dialog"));
    log(`Cuenta offline guardada: ${username}.`, "ok");
  });
  element<HTMLButtonElement>("save-settings").addEventListener("click", () => {
    persistSettingsFromForm();
    closeDialog(element<HTMLDialogElement>("settings-dialog"));
    log("Ajustes globales guardados en este navegador.", "ok");
  });
}

async function init(): Promise<void> {
  fillSettingsForm();
  fillLoaderList(el.newLoaderList, "1.12.2", "");
  fillLoaderList(el.loaderList, "1.12.2", "");
  fillNoLoaderVersion(el.newLoaderVersionList, el.newLoaderStatus);
  fillNoLoaderVersion(el.loaderVersionList, el.loaderStatus);
  bindEvents();
  showHome();
  log("WebPrism listo. Crea una instancia desde «Añadir instancia»: versión en lista, loader en lista y después Iniciar.");

  await registerServiceWorker();
  await checkCapabilities();
  await refreshInstances();
  renderPlanDetails();
  await loadVersions(false);
  await refreshLocalFolderState();
  await updateStorageEstimate();
  if (!instances.length) {
    log("Primera vez: 1.2.5 es la ruta web recomendada; 1.12.2 sirve para probar loaders antiguos. También puedes importar Prism o .minecraft desde Carpetas.");
  }
}

void init().catch((error) => {
  log(`Error fatal al iniciar WebPrism: ${error instanceof Error ? error.message : String(error)}`, "error");
});
