import "./style.css";

import { checkLwjgl2Runtime, isGameRunning, runCheerpjPlan } from "./cheerpj";
import { isValidOfflineUsername, offlineUuid } from "./crypto";
import { formatBytes } from "./download";
import {
  createInstance,
  deleteInstance,
  listInstances,
  renameInstance,
  touchInstanceLaunchTimes,
  updateInstanceSidecar,
  updateInstanceVersion,
} from "./instances";
import { LauncherService, type LaunchPlan, type ResolvedInstanceProfile } from "./launcherService";
import {
  detectLocalFolder,
  exportInstanceToLocal,
  exportMinecraftGameDirToLocal,
  getInstanceDirHandle,
  importMinecraftFolderAsInstance,
  importPrismInstance,
  importPrismInstancesRoot,
  linkSharedCache,
  localChildDir,
  pickDirectory,
  supportsDirectoryPicker,
} from "./localFolder";
import { opfs } from "./opfs";
import { describeComponent, isLoaderComponent } from "./prism";
import { DEFAULT_SETTINGS, type BackendId, type InstanceSummary, type LauncherSettings, type LogListener, type ProgressEvent } from "./types";

const SETTINGS_KEY = "webprism:settings:v1";
const SELECTED_INSTANCE_KEY = "webprism:selected-instance:v1";
const FALLBACK_VERSIONS = ["1.21.4", "1.20.1", "1.16.5", "1.12.2", "1.8.9", "1.7.10", "1.6.4", "1.5.2", "1.2.5"];

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
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      aotUrls: { ...(parsed.aotUrls ?? {}) },
      concurrency: Math.max(1, Math.min(16, parsed.concurrency ?? DEFAULT_SETTINGS.concurrency)),
    };
  } catch {
    return { ...DEFAULT_SETTINGS, aotUrls: {} };
  }
}

let settings: LauncherSettings = loadSettings();
let instances: InstanceSummary[] = [];
let selectedInstance: InstanceSummary | null = null;
let busy = false;
let serviceWorkerControlled = false;
let lastResolved: ResolvedInstanceProfile | null = null;
let lastPlan: LaunchPlan | null = null;

interface VersionOption {
  id: string;
  type: string;
  local: boolean;
}

let versionOptions: VersionOption[] = [];
let localVersionIds = new Set<string>();

const els = {
  username: element<HTMLInputElement>("username"),
  uuidPreview: element<HTMLElement>("uuid-preview"),
  eula: element<HTMLInputElement>("eula"),
  instanceList: element<HTMLDivElement>("instance-list"),
  storageEstimate: element<HTMLElement>("storage-estimate"),
  localDetection: element<HTMLDivElement>("local-detection"),
  proxyBase: element<HTMLInputElement>("proxy-base"),
  cheerpjUrl: element<HTMLInputElement>("cheerpj-url"),
  concurrency: element<HTMLInputElement>("concurrency"),
  heroInstance: element<HTMLElement>("hero-instance"),
  heroVersion: element<HTMLElement>("hero-version"),
  heroMods: element<HTMLElement>("hero-mods"),
  heroSaves: element<HTMLElement>("hero-saves"),
  selectedBadge: element<HTMLElement>("selected-badge"),
  versionSearch: element<HTMLInputElement>("version-search"),
  versionFilter: element<HTMLSelectElement>("version-filter"),
  versionSelect: element<HTMLSelectElement>("version-select"),
  customVersion: element<HTMLInputElement>("custom-version"),
  instanceName: element<HTMLInputElement>("instance-name"),
  backendSelect: element<HTMLSelectElement>("backend-select"),
  windowWidth: element<HTMLInputElement>("window-width"),
  windowHeight: element<HTMLInputElement>("window-height"),
  aotUrl: element<HTMLInputElement>("aot-url"),
  compatibilityBadge: element<HTMLElement>("compatibility-badge"),
  progressLabel: element<HTMLElement>("progress-label"),
  progressDetail: element<HTMLElement>("progress-detail"),
  progressBar: element<HTMLProgressElement>("progress-bar"),
  planDetails: element<HTMLDivElement>("plan-details"),
  gameShell: element<HTMLDivElement>("game-shell"),
  gamePlaceholder: element<HTMLDivElement>("game-placeholder"),
  gameDisplay: element<HTMLDivElement>("game-display"),
  aotFrame: element<HTMLIFrameElement>("aot-frame"),
  log: element<HTMLDivElement>("log"),
};

const log: LogListener = (line, level = "info") => {
  const row = document.createElement("div");
  row.className = `log-line log-${level}`;
  const time = document.createElement("span");
  time.className = "log-time";
  time.textContent = new Date().toLocaleTimeString("es-ES", { hour12: false });
  row.append(time, document.createTextNode(line));
  els.log.appendChild(row);
  while (els.log.children.length > 700) els.log.firstElementChild?.remove();
  els.log.scrollTop = els.log.scrollHeight;
  const consoleFn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  consoleFn(`[WebPrism] ${line}`);
};

const service = new LauncherService({
  proxyBase: () => settings.proxyBase,
  concurrency: () => settings.concurrency,
  log,
});

function setProgress(event: ProgressEvent | null): void {
  if (!event) {
    els.progressLabel.textContent = "Listo";
    els.progressDetail.textContent = "Sin tareas en curso";
    els.progressBar.removeAttribute("value");
    els.progressBar.max = 100;
    return;
  }
  const percent = event.total > 0 ? Math.max(0, Math.min(100, (event.done / event.total) * 100)) : 0;
  els.progressLabel.textContent = event.phase;
  const byteText = event.bytesTotal ? ` · ${formatBytes(event.bytesDone ?? 0)} / ${formatBytes(event.bytesTotal)}` : event.bytesDone ? ` · ${formatBytes(event.bytesDone)}` : "";
  els.progressDetail.textContent = `${event.done}/${event.total}${byteText}${event.current ? ` · ${event.current}` : ""}`;
  els.progressBar.max = 100;
  els.progressBar.value = percent;
}

function setBusy(nextBusy: boolean, label?: string): void {
  busy = nextBusy;
  const keepEnabled = new Set(["fullscreen-game", "reload-page", "clear-log", "download-log"]);
  document.querySelectorAll<HTMLElement>("button, input, select").forEach((control) => {
    if (control instanceof HTMLButtonElement || control instanceof HTMLInputElement || control instanceof HTMLSelectElement) {
      control.disabled = nextBusy && !keepEnabled.has(control.id);
    }
  });
  if (nextBusy && label) {
    els.progressLabel.textContent = label;
    els.progressDetail.textContent = "Trabajando…";
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
    log(error instanceof Error ? error.message : String(error), "error");
  } finally {
    setBusy(false);
    void updateStorageEstimate();
  }
}

function persistSettingsFromForm(): LauncherSettings {
  settings = {
    ...settings,
    username: els.username.value.trim(),
    proxyBase: els.proxyBase.value.trim(),
    cheerpjLoaderUrl: els.cheerpjUrl.value.trim() || DEFAULT_SETTINGS.cheerpjLoaderUrl,
    concurrency: Math.max(1, Math.min(16, Number.parseInt(els.concurrency.value, 10) || DEFAULT_SETTINGS.concurrency)),
  };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  updateUuidPreview();
  return settings;
}

function fillSettingsForm(): void {
  els.username.value = settings.username;
  els.proxyBase.value = settings.proxyBase;
  els.cheerpjUrl.value = settings.cheerpjLoaderUrl;
  els.concurrency.value = String(settings.concurrency);
  updateUuidPreview();
}

function updateUuidPreview(): void {
  const username = els.username.value.trim();
  els.uuidPreview.textContent = username ? offlineUuid(username, true) : "—";
}

function setChip(id: string, state: "ok" | "warn" | "bad" | "muted", text: string): void {
  const chip = element<HTMLElement>(id);
  chip.className = `chip chip-${state}`;
  chip.textContent = text;
}

async function updateStorageEstimate(): Promise<void> {
  const estimate = await opfs.estimate().catch((): { usage?: number; quota?: number } => ({}));
  if (estimate.usage !== undefined && estimate.quota !== undefined) {
    els.storageEstimate.textContent = `Almacenamiento del origen: ${formatBytes(estimate.usage)} / ${formatBytes(estimate.quota)}. Los juegos viven en OPFS + la caché interna de CheerpJ.`;
  } else {
    els.storageEstimate.textContent = "Almacenamiento del origen: el navegador no ofrece estimación.";
  }
}

function currentVersionInput(): string {
  return els.customVersion.value.trim() || els.versionSelect.value;
}

function renderVersionOptions(): void {
  const previous = currentVersionInput() || selectedInstance?.minecraftVersion || "1.12.2";
  const search = els.versionSearch.value.trim().toLowerCase();
  const filter = els.versionFilter.value;
  const filtered = versionOptions.filter((option) => {
    if (search && !option.id.toLowerCase().includes(search)) return false;
    switch (filter) {
      case "release":
        return option.type === "release";
      case "snapshot":
        return option.type === "snapshot";
      case "old":
        return option.type === "old_beta" || option.type === "old_alpha";
      case "local":
        return option.local;
      default:
        return true;
    }
  });

  els.versionSelect.replaceChildren();
  if (!filtered.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "Sin resultados — escribe un ID personalizado";
    option.disabled = true;
    option.selected = true;
    els.versionSelect.appendChild(option);
    return;
  }

  for (const entry of filtered.slice(0, 1500)) {
    const option = document.createElement("option");
    option.value = entry.id;
    option.textContent = `${entry.id} · ${entry.type}${entry.local ? " · local/cache" : ""}`;
    els.versionSelect.appendChild(option);
  }

  if (filtered.some((entry) => entry.id === previous)) {
    els.versionSelect.value = previous;
  } else if (filtered.some((entry) => entry.id === "1.12.2")) {
    els.versionSelect.value = "1.12.2";
  }
}

async function loadVersions(forceRefresh = false): Promise<void> {
  localVersionIds = new Set(await service.listCachedVersionIds().catch(() => []));
  try {
    const manifest = await service.getManifest(forceRefresh);
    const byId = new Map<string, VersionOption>();
    for (const version of manifest.versions) {
      byId.set(version.id, { id: version.id, type: version.type, local: localVersionIds.has(version.id) });
    }
    for (const localId of localVersionIds) {
      if (!byId.has(localId)) byId.set(localId, { id: localId, type: "local", local: true });
    }
    versionOptions = [...byId.values()];
    log(`Manifiesto de Mojang cargado: ${manifest.versions.length} versiones (última release ${manifest.latest.release}).`, "ok");
  } catch (error) {
    const byId = new Map<string, VersionOption>();
    for (const id of FALLBACK_VERSIONS) byId.set(id, { id, type: "release", local: localVersionIds.has(id) });
    for (const localId of localVersionIds) byId.set(localId, { id: localId, type: "local", local: true });
    versionOptions = [...byId.values()];
    log(`No se pudo cargar el manifiesto de Mojang (${error instanceof Error ? error.message : String(error)}). Se muestra una lista corta; puedes escribir cualquier ID en el campo personalizado.`, "warn");
  }
  renderVersionOptions();
}

function renderInstanceList(): void {
  els.instanceList.replaceChildren();
  if (!instances.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "Aún no hay instancias. Crea una o importa una carpeta de Prism/.minecraft.";
    els.instanceList.appendChild(empty);
    return;
  }

  for (const instance of instances) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = `instance-card${instance.id === selectedInstance?.id ? " selected" : ""}`;
    const title = document.createElement("strong");
    title.textContent = instance.name;
    const meta = document.createElement("div");
    meta.className = "instance-meta";
    const componentText = instance.components
      .filter((component) => !component.disabled)
      .map((component) => `${describeComponent(component.uid)}${component.version ? ` ${component.version}` : ""}`)
      .join(" · ");
    for (const item of [instance.minecraftVersion || "sin versión", `${instance.modCount} mods`, `${instance.saveCount} mundos`, instance.sidecar.backend, componentText]) {
      if (!item) continue;
      const span = document.createElement("span");
      span.textContent = item;
      meta.appendChild(span);
    }
    card.append(title, meta);
    card.addEventListener("click", () => {
      selectedInstance = instances.find((candidate) => candidate.id === instance.id) ?? instance;
      localStorage.setItem(SELECTED_INSTANCE_KEY, selectedInstance.id);
      lastResolved = null;
      lastPlan = null;
      renderInstanceList();
      renderSelected();
      renderPlanDetails();
    });
    els.instanceList.appendChild(card);
  }
}

function aotUrlFromFormOrInstance(instance: InstanceSummary | null): string {
  const formValue = els.aotUrl.value.trim();
  if (formValue) return formValue;
  if (!instance) return "";
  return instance.sidecar.aotUrl ?? settings.aotUrls[instance.minecraftVersion] ?? "";
}

function renderSelected(): void {
  const instance = selectedInstance;
  els.selectedBadge.textContent = instance ? `${instance.name} (${instance.id})` : "Sin selección";
  els.heroInstance.textContent = instance?.name ?? "—";
  els.heroVersion.textContent = instance?.minecraftVersion ?? currentVersionInput() ?? "—";
  els.heroMods.textContent = String(instance?.modCount ?? 0);
  els.heroSaves.textContent = String(instance?.saveCount ?? 0);

  if (!instance) return;
  els.backendSelect.value = instance.sidecar.backend;
  els.windowWidth.value = String(instance.sidecar.windowWidth || 854);
  els.windowHeight.value = String(instance.sidecar.windowHeight || 480);
  els.aotUrl.value = instance.sidecar.aotUrl ?? settings.aotUrls[instance.minecraftVersion] ?? "";

  if (instance.minecraftVersion) {
    els.versionSelect.value = instance.minecraftVersion;
    if (els.versionSelect.value === instance.minecraftVersion) {
      if (els.customVersion.value.trim() === instance.minecraftVersion) els.customVersion.value = "";
    } else {
      // The version exists but is filtered out of the current dropdown view.
      els.customVersion.value = instance.minecraftVersion;
    }
  }
}

async function refreshInstances(preferredId?: string): Promise<void> {
  instances = await listInstances();
  const wanted = preferredId ?? localStorage.getItem(SELECTED_INSTANCE_KEY) ?? selectedInstance?.id;
  selectedInstance = instances.find((instance) => instance.id === wanted) ?? instances[0] ?? null;
  if (selectedInstance) localStorage.setItem(SELECTED_INSTANCE_KEY, selectedInstance.id);
  renderInstanceList();
  renderSelected();
  await updateStorageEstimate();
}

function renderPlanDetails(): void {
  const resolved = lastPlan ? { profile: lastPlan.profile, compatibility: lastPlan.compatibility } : lastResolved;
  if (!resolved) {
    els.compatibilityBadge.className = "badge badge-muted";
    els.compatibilityBadge.textContent = "Sin resolver";
    els.planDetails.innerHTML = `<p class="empty">Resuelve un perfil para ver Java requerido, librerías, compatibilidad, argumentos y bloqueos reales.</p>`;
    return;
  }

  const { profile, compatibility } = resolved;
  els.compatibilityBadge.className = `badge ${compatibility.status === "blocked" ? "badge-bad" : compatibility.status === "known-good" ? "badge-ok" : "badge-warn"}`;
  els.compatibilityBadge.textContent = compatibility.title;

  const classpathCount = lastResolved?.classified.filter((entry) => entry.includeOnClasspath).length ?? profile.libraries.length;
  const reasons = [...compatibility.reasons, ...profile.warnings.filter((warning) => !compatibility.reasons.includes(warning))];
  const stats: Array<[string, string]> = [
    ["Perfil", profile.id],
    ["Cliente Mojang", profile.clientVersionId],
    ["Main class", profile.mainClass || "—"],
    ["Java", `${profile.javaMajor} → CheerpJ ${compatibility.javaRuntime ?? "sin runtime"}`],
    ["Librerías", `${profile.libraries.length} declaradas · ${classpathCount} en classpath`],
    ["Assets", profile.assetIndex?.id ?? "sin assetIndex"],
    ["Fuente", profile.sourceChain.join(" → ")],
    ["Backend gráficos", compatibility.hasLwjgl3 ? "LWJGL3 (bloqueado)" : compatibility.hasLwjgl2 ? "LWJGL2 wasm + gl4es" : "genérico/CheerpJ"],
  ];
  if (lastPlan) {
    stats.push(["Descargas", `${lastPlan.downloads.files} archivos · ${formatBytes(lastPlan.downloads.bytes)}`]);
    stats.push(["GameDir JVM", lastPlan.gameDirJvmPath]);
  }

  els.planDetails.innerHTML = `
    <div class="plan-grid">
      ${stats.map(([label, value]) => `<div class="plan-stat"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join("")}
    </div>
    ${compatibility.blockers.length ? `<h3>Bloqueos</h3><ul>${compatibility.blockers.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : ""}
    ${reasons.length ? `<h3>Notas</h3><ul>${reasons.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : ""}
    ${compatibility.nativeLibraries.length ? `<details><summary>Librerías con nativos de escritorio (${compatibility.nativeLibraries.length})</summary><pre>${escapeHtml(compatibility.nativeLibraries.join("\n"))}</pre></details>` : ""}
    ${lastPlan ? `<details><summary>Argumentos del juego</summary><pre>${escapeHtml(lastPlan.gameArgs.join("\n"))}</pre></details>` : ""}
    ${lastPlan ? `<details><summary>Classpath JVM</summary><pre>${escapeHtml(lastPlan.classpathJvmPaths.join("\n"))}</pre></details>` : ""}
    ${lastPlan?.ignoredJvmArgs.length ? `<details><summary>Argumentos JVM ignorados/traducidos</summary><pre>Propiedades:\n${escapeHtml(lastPlan.javaProperties.join("\n") || "—")}\n\nIgnorados:\n${escapeHtml(lastPlan.ignoredJvmArgs.join("\n"))}</pre></details>` : ""}
  `;
}

async function persistSelectedInstanceSettings(): Promise<InstanceSummary> {
  if (!selectedInstance) throw new Error("Crea o selecciona una instancia primero.");
  persistSettingsFromForm();
  const aotUrl = els.aotUrl.value.trim();
  const updated = await updateInstanceSidecar(selectedInstance.id, {
    backend: els.backendSelect.value as BackendId,
    windowWidth: Math.max(320, Number.parseInt(els.windowWidth.value, 10) || 854),
    windowHeight: Math.max(200, Number.parseInt(els.windowHeight.value, 10) || 480),
    aotUrl: aotUrl || undefined,
  });
  if (aotUrl && updated.minecraftVersion) {
    settings = { ...settings, aotUrls: { ...settings.aotUrls, [updated.minecraftVersion]: aotUrl } };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }
  selectedInstance = updated;
  instances = instances.map((instance) => (instance.id === updated.id ? updated : instance));
  renderInstanceList();
  renderSelected();
  return updated;
}

async function ensureInstanceForPlay(): Promise<InstanceSummary> {
  if (selectedInstance) return persistSelectedInstanceSettings();
  const version = currentVersionInput();
  if (!version) throw new Error("Elige una versión o escribe un ID de perfil.");
  const name = els.instanceName.value.trim() || `Minecraft ${version} web`;
  const created = await createInstance({ name, minecraftVersion: version, backend: els.backendSelect.value as BackendId });
  await refreshInstances(created.id);
  log(`Se creó automáticamente la instancia «${created.name}» para jugar.`, "ok");
  return persistSelectedInstanceSettings();
}

function validatePlayInputs(instance: InstanceSummary): void {
  const username = els.username.value.trim();
  if (!isValidOfflineUsername(username)) {
    throw new Error("El nombre de usuario offline debe tener 3–16 caracteres: letras, números o guion bajo.");
  }
  if (!els.eula.checked) throw new Error("Acepta el EULA de Minecraft antes de descargar o ejecutar el juego.");
  if (!instance.minecraftVersion) throw new Error("La instancia no tiene versión de Minecraft en mmc-pack.json.");
}

function effectiveBackend(instance: InstanceSummary): "cheerpj" | "aot" {
  const requested = instance.sidecar.backend;
  if (requested === "cheerpj" || requested === "aot") return requested;
  const hasLoaderOrMods = instance.modCount > 0 || instance.components.some((component) => !component.disabled && isLoaderComponent(component.uid));
  return aotUrlFromFormOrInstance(instance) && !hasLoaderOrMods ? "aot" : "cheerpj";
}

async function playAot(instance: InstanceSummary): Promise<void> {
  const rawUrl = aotUrlFromFormOrInstance(instance);
  if (!rawUrl) {
    throw new Error("El backend AOT necesita la URL de un bundle TeaVM/Eagler que tú alojes. WebPrism no incluye ese cliente por licencia/distribución.");
  }
  const url = new URL(rawUrl, window.location.href);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("La URL AOT debe ser http(s).");

  els.gamePlaceholder.hidden = true;
  els.gameDisplay.hidden = true;
  els.aotFrame.hidden = false;
  els.aotFrame.src = "about:blank";
  requestAnimationFrame(() => {
    els.aotFrame.src = url.toString();
  });
  const now = Date.now();
  await touchInstanceLaunchTimes(instance.id, now, now);
  log(`Bundle AOT cargado desde ${url.toString()}. El nombre de usuario se configura dentro del propio bundle si no acepta parámetros externos.`, "ok");
}

async function playCheerpj(instance: InstanceSummary): Promise<void> {
  if (!serviceWorkerControlled) {
    throw new Error("El Service Worker aún no controla la página, así que CheerpJ no puede leer la caché OPFS mediante /app/webprism-data. Recarga la página y vuelve a intentarlo.");
  }
  if (isGameRunning()) throw new Error("Ya hay una JVM en marcha en esta pestaña.");

  const resolved = await service.resolveInstance(instance);
  lastResolved = resolved;
  lastPlan = null;
  renderPlanDetails();
  if (resolved.compatibility.status === "blocked") {
    throw new Error(`No se inicia la descarga porque el perfil está bloqueado: ${resolved.compatibility.blockers.join(" ")}`);
  }

  const plan = await service.prepareLaunchPlan(instance, {
    username: els.username.value.trim(),
    width: instance.sidecar.windowWidth,
    height: instance.sidecar.windowHeight,
    onProgress: setProgress,
  });
  lastPlan = plan;
  renderPlanDetails();

  els.gamePlaceholder.hidden = true;
  els.aotFrame.hidden = true;
  els.aotFrame.src = "about:blank";
  els.gameDisplay.hidden = false;
  els.gameShell.scrollIntoView({ behavior: "smooth", block: "start" });

  const startedAt = Date.now();
  try {
    await runCheerpjPlan(instance, plan, {
      loaderUrl: settings.cheerpjLoaderUrl,
      display: els.gameDisplay,
      onLog: log,
      onProgress: setProgress,
      onJvmSyncComplete: async (timestamp) => {
        const updated = await updateInstanceSidecar(instance.id, { lastJvmSyncAt: timestamp });
        selectedInstance = updated;
      },
    });
  } finally {
    await touchInstanceLaunchTimes(instance.id, startedAt, Date.now()).catch(() => undefined);
    await refreshInstances(instance.id);
  }
}

async function registerServiceWorker(): Promise<void> {
  if (!("serviceWorker" in navigator)) {
    setChip("chip-sw", "bad", "Service Worker no soportado");
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
    setChip("chip-sw", serviceWorkerControlled ? "ok" : "warn", serviceWorkerControlled ? "Service Worker activo" : "Service Worker: recarga");
    if (!serviceWorkerControlled) log("El Service Worker se instaló pero todavía no controla esta carga; recarga una vez antes de arrancar CheerpJ.", "warn");
  } catch (error) {
    setChip("chip-sw", "bad", "Service Worker falló");
    log(`No se pudo registrar el Service Worker: ${error instanceof Error ? error.message : String(error)}`, "error");
  }
}

async function checkCapabilities(): Promise<void> {
  try {
    await opfs.ensureDir("cache");
    const persistent = await opfs.requestPersistence();
    setChip("chip-opfs", "ok", persistent ? "OPFS persistente" : "OPFS activo");
  } catch (error) {
    setChip("chip-opfs", "bad", "OPFS no disponible");
    log(error instanceof Error ? error.message : String(error), "error");
  }

  const fsSupported = supportsDirectoryPicker();
  setChip("chip-fs", fsSupported ? "ok" : "warn", fsSupported ? "Carpetas locales sí" : "Carpetas locales no (Chromium)");

  const canvas = document.createElement("canvas");
  const webgl2 = Boolean(canvas.getContext("webgl2"));
  setChip("chip-webgl", webgl2 ? "ok" : "warn", webgl2 ? "WebGL2 activo" : "WebGL2 no detectado");

  const runtime = await checkLwjgl2Runtime().catch(() => ({ ok: false, missing: ["runtime"] }));
  setChip("chip-lwjgl", runtime.ok ? "ok" : "warn", runtime.ok ? "LWJGL2 wasm listo" : "LWJGL2 wasm falta");
  if (!runtime.ok) log("Falta el runtime LWJGL2 wasm en /lwjgl. En el despliegue ejecuta `npm run setup:runtime` (no se versiona en Git).", "warn");
}

function bindEvents(): void {
  els.username.addEventListener("input", updateUuidPreview);
  els.versionSearch.addEventListener("input", renderVersionOptions);
  els.versionFilter.addEventListener("change", renderVersionOptions);
  els.versionSelect.addEventListener("change", () => {
    els.customVersion.value = "";
    els.heroVersion.textContent = els.versionSelect.value;
  });
  els.customVersion.addEventListener("input", () => {
    els.heroVersion.textContent = currentVersionInput();
  });

  element<HTMLButtonElement>("refresh-versions").addEventListener("click", () => {
    void runTask("Actualizando versiones", async () => {
      persistSettingsFromForm();
      await loadVersions(true);
    });
  });

  element<HTMLButtonElement>("refresh-instances").addEventListener("click", () => {
    void runTask("Recargando instancias", async () => refreshInstances());
  });

  element<HTMLButtonElement>("save-settings").addEventListener("click", () => {
    persistSettingsFromForm();
    log("Ajustes guardados en este navegador.", "ok");
  });

  element<HTMLButtonElement>("create-instance").addEventListener("click", () => {
    void runTask("Creando instancia", async () => {
      persistSettingsFromForm();
      const version = currentVersionInput();
      if (!version) throw new Error("Elige una versión o escribe un ID personalizado.");
      const name = els.instanceName.value.trim() || `Minecraft ${version} web`;
      const created = await createInstance({ name, minecraftVersion: version, backend: els.backendSelect.value as BackendId });
      await refreshInstances(created.id);
      await persistSelectedInstanceSettings();
      lastResolved = null;
      lastPlan = null;
      renderPlanDetails();
      log(`Instancia «${created.name}» creada en OPFS con instance.cfg + mmc-pack.json compatibles con Prism.`, "ok");
    });
  });

  element<HTMLButtonElement>("apply-version").addEventListener("click", () => {
    void runTask("Actualizando versión", async () => {
      if (!selectedInstance) throw new Error("Selecciona una instancia primero.");
      const version = currentVersionInput();
      if (!version) throw new Error("Elige una versión válida.");
      selectedInstance = await updateInstanceVersion(selectedInstance, version);
      await refreshInstances(selectedInstance.id);
      lastResolved = null;
      lastPlan = null;
      renderPlanDetails();
      log(`Versión de la instancia actualizada a ${version} en mmc-pack.json.`, "ok");
    });
  });

  element<HTMLButtonElement>("save-instance-settings").addEventListener("click", () => {
    void runTask("Guardando instancia", async () => {
      await persistSelectedInstanceSettings();
      log("Backend, ventana y URL AOT guardados en webprism.json (Prism ignora ese archivo extra).", "ok");
    });
  });

  element<HTMLButtonElement>("rename-instance").addEventListener("click", () => {
    void runTask("Renombrando instancia", async () => {
      if (!selectedInstance) throw new Error("Selecciona una instancia primero.");
      const name = window.prompt("Nuevo nombre visible (no cambia el ID de carpeta):", selectedInstance.name)?.trim();
      if (!name) return;
      selectedInstance = await renameInstance(selectedInstance, name);
      await refreshInstances(selectedInstance.id);
      log(`Instancia renombrada a «${name}».`, "ok");
    });
  });

  element<HTMLButtonElement>("delete-instance").addEventListener("click", () => {
    void runTask("Eliminando instancia", async () => {
      if (!selectedInstance) throw new Error("Selecciona una instancia primero.");
      const confirmed = window.confirm(`¿Eliminar «${selectedInstance.name}» de OPFS? Esto borra mundos/mods de la copia web, no tu carpeta local.`);
      if (!confirmed) return;
      await deleteInstance(selectedInstance.id);
      selectedInstance = null;
      lastResolved = null;
      lastPlan = null;
      await refreshInstances();
      renderPlanDetails();
      log("Instancia eliminada de OPFS.", "ok");
    });
  });

  element<HTMLButtonElement>("import-prism").addEventListener("click", () => {
    void runTask("Importando Prism", async () => {
      const dir = await pickDirectory("read");
      const detection = await detectLocalFolder(dir);
      els.localDetection.textContent = detection.summary;
      if (detection.kind === "prism-instance") {
        const id = await importPrismInstance(dir, setProgress, log);
        await refreshInstances(id);
      } else if (detection.kind === "prism-instances-root") {
        const ids = await importPrismInstancesRoot(dir, setProgress, log);
        if (!ids.length) throw new Error("No se pudo importar ninguna instancia de esa carpeta.");
        await refreshInstances(ids[0]);
        log(`Importadas ${ids.length} instancia(s) Prism.`, "ok");
      } else {
        throw new Error(`La carpeta no parece una instancia Prism ni una carpeta raíz de instancias. ${detection.summary}`);
      }
      lastResolved = null;
      lastPlan = null;
      renderPlanDetails();
    });
  });

  element<HTMLButtonElement>("import-minecraft").addEventListener("click", () => {
    void runTask("Importando .minecraft", async () => {
      const dir = await pickDirectory("read");
      const detection = await detectLocalFolder(dir);
      els.localDetection.textContent = detection.summary;
      if (detection.kind !== "minecraft" && detection.kind !== "shared-cache") {
        throw new Error(`Selecciona una carpeta .minecraft o datos de Prism con versions/libraries/assets. ${detection.summary}`);
      }
      const version = currentVersionInput() || detection.versionIds[0] || "1.12.2";
      const id = await importMinecraftFolderAsInstance(dir, version, setProgress, log);
      await refreshInstances(id);
      await loadVersions(false);
      lastResolved = null;
      lastPlan = null;
      renderPlanDetails();
    });
  });

  element<HTMLButtonElement>("link-cache").addEventListener("click", () => {
    void runTask("Vinculando caché local", async () => {
      const dir = await pickDirectory("read");
      const detection = await linkSharedCache(dir);
      els.localDetection.textContent = detection.summary;
      if (detection.kind === "unknown") {
        log("La carpeta quedó vinculada, pero no parece contener versions + libraries/assets; el launcher descargará lo que falte de Mojang.", "warn");
      } else {
        log(`Caché local vinculada: ${detection.summary}`, "ok");
      }
      await loadVersions(false);
    });
  });

  element<HTMLButtonElement>("export-instance").addEventListener("click", () => {
    void runTask("Exportando a disco", async () => {
      if (!selectedInstance) throw new Error("Selecciona una instancia primero.");
      if (isGameRunning()) throw new Error("Espera a que termine la JVM antes de exportar; si no, los mundos pueden quedar a medias.");
      const instance = selectedInstance;
      if (instance.sidecar.linkedLocalKind === "minecraft") {
        const target = (await getInstanceDirHandle(instance.id, "readwrite", true)) ?? (await pickDirectory("readwrite"));
        await exportMinecraftGameDirToLocal(instance.id, instance.gameDirName, target, setProgress, log);
      } else {
        let target = await getInstanceDirHandle(instance.id, "readwrite", true);
        if (!target) {
          target = await pickDirectory("readwrite");
          const detection = await detectLocalFolder(target);
          if (detection.kind === "prism-instances-root") {
            const child = await localChildDir(target, instance.id, { create: true });
            if (!child) throw new Error("No se pudo crear la subcarpeta de la instancia dentro de la carpeta raíz elegida.");
            target = child;
            log(`La carpeta elegida es una raíz de instancias; se exportará a ${instance.id}/ dentro de ella.`);
          }
        }
        if (!target) throw new Error("No hay carpeta destino para exportar.");
        const exportTarget: FileSystemDirectoryHandle = target;
        await exportInstanceToLocal(instance.id, exportTarget, setProgress, log);
        await updateInstanceSidecar(instance.id, { linkedLocalKind: "prism-instance", linkedLocalName: exportTarget.name });
        await refreshInstances(instance.id);
      }
    });
  });

  element<HTMLButtonElement>("resolve-profile").addEventListener("click", () => {
    void runTask("Resolviendo perfil", async () => {
      const instance = await persistSelectedInstanceSettings();
      lastResolved = await service.resolveInstance(instance);
      lastPlan = null;
      renderPlanDetails();
      log(`Perfil ${lastResolved.profile.id}: ${lastResolved.compatibility.title}.`, lastResolved.compatibility.status === "blocked" ? "warn" : "ok");
    });
  });

  element<HTMLButtonElement>("prepare-plan").addEventListener("click", () => {
    void runTask("Descargando y preparando", async () => {
      const instance = await persistSelectedInstanceSettings();
      if (!els.eula.checked) throw new Error("Acepta el EULA antes de descargar archivos del juego.");
      lastResolved = await service.resolveInstance(instance);
      if (lastResolved.compatibility.status === "blocked") {
        log("Este perfil está bloqueado para ejecutar en JVM; se preparará la descarga igualmente porque lo has pedido explícitamente.", "warn");
      }
      lastPlan = await service.prepareLaunchPlan(instance, {
        username: els.username.value.trim() || "Steve",
        width: instance.sidecar.windowWidth,
        height: instance.sidecar.windowHeight,
        onProgress: setProgress,
      });
      renderPlanDetails();
    });
  });

  element<HTMLButtonElement>("play").addEventListener("click", () => {
    void runTask("Jugando", async () => {
      const instance = await ensureInstanceForPlay();
      validatePlayInputs(instance);
      const backend = effectiveBackend(instance);
      log(`Backend efectivo: ${backend === "aot" ? "AOT/TeaVM" : "CheerpJ (JVM real)"}.`);
      if (backend === "aot") await playAot(instance);
      else await playCheerpj(instance);
    });
  });

  element<HTMLButtonElement>("fullscreen-game").addEventListener("click", () => {
    void els.gameShell.requestFullscreen?.().catch((error) => log(`Pantalla completa no disponible: ${error instanceof Error ? error.message : String(error)}`, "warn"));
  });

  element<HTMLButtonElement>("reload-page").addEventListener("click", () => window.location.reload());

  element<HTMLButtonElement>("clear-log").addEventListener("click", () => els.log.replaceChildren());
  element<HTMLButtonElement>("download-log").addEventListener("click", () => {
    const blob = new Blob([els.log.innerText], { type: "text/plain; charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "webprism-launcher.log";
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  });
}

async function init(): Promise<void> {
  fillSettingsForm();
  bindEvents();
  log("WebPrism iniciado. Los archivos de Mojang se descargan en tu navegador y se guardan en OPFS; el servidor solo entrega esta aplicación.");

  await registerServiceWorker();
  await checkCapabilities();
  await refreshInstances();
  renderPlanDetails();
  await loadVersions(false);
  renderSelected();
  await updateStorageEstimate();

  if (!instances.length) {
    log("Primera vez: elige 1.2.5 para la ruta JVM demostrada, o importa una instancia/carpeta local. Al pulsar Jugar se creará una instancia automáticamente si no hay ninguna.");
  }
}

void init().catch((error) => {
  log(`Error fatal al iniciar WebPrism: ${error instanceof Error ? error.message : String(error)}`, "error");
});
