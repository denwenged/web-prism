export type BackendId = "auto" | "cheerpj" | "aot";

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
  saveCount: number;
}

export interface PrismComponent {
  uid: string;
  version?: string;
  cachedVersion?: string;
  cachedName?: string;
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
  proxyBase: string;
  cheerpjLoaderUrl: string;
  aotUrls: Record<string, string>;
  concurrency: number;
}

export const DEFAULT_SETTINGS: LauncherSettings = {
  username: "Steve",
  proxyBase: "/api/proxy?url=",
  cheerpjLoaderUrl: "https://cjrtnc.leaningtech.com/4.3/loader.js",
  aotUrls: {},
  concurrency: 8,
};
