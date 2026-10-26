export type BackendId = "auto" | "cheerpj" | "aot" | "manage";

export interface WebPrismInstanceSidecar {
  formatVersion: 1;
  backend: BackendId;
  /** URL of a user-hosted TeaVM/Eaglercraft-style HTML bundle for this instance. */
  aotUrl?: string;
  windowWidth: number;
  windowHeight: number;
  createdAt: string;
  lastJvmSyncAt?: number;
  linkedLocalKind?: "prism-instance" | "minecraft" | "none";
  linkedLocalName?: string;
}

export interface PrismRequirement {
  uid: string;
  equals?: string;
  suggests?: string;
}

export interface InstanceSummary {
  id: string;
  name: string;
  iconKey: string;
  notes: string;
  minecraftVersion: string;
  components: PrismComponent[];
  sidecar: WebPrismInstanceSidecar;
  gameDirName: "minecraft" | ".minecraft";
  modCount: number;
  resourcePackCount: number;
  shaderPackCount: number;
  dataPackCount: number;
  saveCount: number;
  lastLaunchTime: number;
  totalTimePlayed: number;
}

export interface PrismComponent {
  uid: string;
  version?: string;
  cachedVersion?: string;
  cachedName?: string;
  cachedRequires?: PrismRequirement[];
  cachedConflicts?: PrismRequirement[];
  dependencyOnly?: boolean;
  important?: boolean;
  disabled?: boolean;
  [key: string]: unknown;
}

export interface PrismPackProfile {
  formatVersion: number;
  components: PrismComponent[];
}

export interface InstanceSettings {
  [key: string]: string;
}

export interface ProgressEvent {
  phase: string;
  done: number;
  total: number;
  current?: string;
  bytesDone?: number;
  bytesTotal?: number;
}

export type ProgressListener = (event: ProgressEvent) => void;
export type LogListener = (line: string, level?: "info" | "warn" | "error" | "ok") => void;

export interface LauncherSettings {
  username: string;
  eulaAccepted: boolean;
  proxyBase: string;
  prismMetaBaseUrl: string;
  cheerpjLoaderUrl: string;
  aotUrls: Record<string, string>;
  concurrency: number;
}

export const DEFAULT_SETTINGS: LauncherSettings = {
  username: "Steve",
  eulaAccepted: false,
  proxyBase: "/api/proxy?url=",
  prismMetaBaseUrl: "https://meta.prismlauncher.org/v1/",
  cheerpjLoaderUrl: "https://cjrtnc.leaningtech.com/4.3/loader.js",
  aotUrls: {},
  concurrency: 8,
};
