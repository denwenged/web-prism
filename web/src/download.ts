import { sha1Hex } from "./crypto";
import { opfs } from "./opfs";

export interface LocalFileSource {
  getFile(candidates: string[]): Promise<File | null>;
}

export interface FetchOptions {
  proxyBase: string;
}

function proxyUrl(proxyBase: string, url: string): string {
  if (!proxyBase) return url;
  return proxyBase.includes("{url}") ? proxyBase.replace("{url}", encodeURIComponent(url)) : `${proxyBase}${encodeURIComponent(url)}`;
}

const proxyPreferredHosts = new Set<string>();

export async function fetchWithFallback(url: string, options: FetchOptions, init: RequestInit = {}): Promise<Response> {
  let host = "";
  try {
    host = new URL(url).host;
  } catch {
    host = "";
  }

  // If a host already failed once (typically CORS), do not repeat the failed
  // direct request for every one of the thousands of asset objects.
  if (host && proxyPreferredHosts.has(host)) {
    const proxied = proxyUrl(options.proxyBase, url);
    if (proxied !== url) return fetch(proxied, init);
  }

  try {
    const response = await fetch(url, init);
    if (response.ok) return response;
    // A non-OK direct response is usually a real 404/410, not CORS. Return it
    // so callers can produce a precise error instead of hiding it behind proxy noise.
    if (response.status >= 400 && response.status < 500) return response;
    throw new Error(`HTTP ${response.status}`);
  } catch (directError) {
    if (host) proxyPreferredHosts.add(host);
    const fallback = proxyUrl(options.proxyBase, url);
    if (fallback === url) throw directError;
    const response = await fetch(fallback, init);
    if (!response.ok) {
      throw new Error(`No se pudo descargar ${url}: directo falló (${directError instanceof Error ? directError.message : String(directError)}) y el proxy devolvió HTTP ${response.status}`);
    }
    return response;
  }
}

export async function fetchJson<T>(url: string, options: FetchOptions): Promise<T> {
  const response = await fetchWithFallback(url, options, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`HTTP ${response.status} al descargar ${url}`);
  return (await response.json()) as T;
}

async function readResponseToBuffer(response: Response, onBytes?: (received: number, total?: number) => void): Promise<ArrayBuffer> {
  const totalHeader = response.headers.get("content-length");
  const total = totalHeader ? Number.parseInt(totalHeader, 10) : undefined;
  if (!response.body) return response.arrayBuffer();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    onBytes?.(received, total);
  }

  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}

async function verifyBuffer(buffer: ArrayBuffer, expectedSha1?: string, label?: string): Promise<void> {
  if (!expectedSha1) return;
  const actual = await sha1Hex(buffer);
  if (actual.toLowerCase() !== expectedSha1.toLowerCase()) {
    throw new Error(`SHA-1 no coincide para ${label ?? "archivo"}: esperado ${expectedSha1}, obtenido ${actual}`);
  }
}

export interface EnsureFileRequest {
  label: string;
  opfsPath: string;
  url?: string;
  sha1?: string;
  size?: number;
  localCandidates?: string[];
  opfsCandidates?: string[];
  /** Asset objects are content-addressed; size match is normally enough on later launches. */
  verifyExisting?: boolean;
}

export type EnsureFileSource = "cache" | "local" | "opfs" | "download";

export interface EnsureFileResult {
  source: EnsureFileSource;
  size: number;
}

export class Downloader {
  constructor(
    private readonly options: FetchOptions,
    private readonly localSource?: LocalFileSource,
  ) {}

  async fetchJson<T>(url: string): Promise<T> {
    return fetchJson<T>(url, this.options);
  }

  async ensureFile(request: EnsureFileRequest, onBytes?: (received: number, total?: number) => void): Promise<EnsureFileResult> {
    const existing = await opfs.readOptionalFile(request.opfsPath);
    if (existing) {
      const sizeMatches = request.size === undefined || existing.size === request.size;
      if (sizeMatches) {
        if (!request.sha1 || request.verifyExisting === false) return { source: "cache", size: existing.size };
        const actual = await sha1Hex(existing);
        if (actual.toLowerCase() === request.sha1.toLowerCase()) return { source: "cache", size: existing.size };
      }
    }

    for (const candidate of request.opfsCandidates ?? []) {
      if (candidate === request.opfsPath) continue;
      const candidateFile = await opfs.readOptionalFile(candidate);
      if (!candidateFile) continue;
      if (request.size !== undefined && candidateFile.size !== request.size) continue;
      const buffer = await candidateFile.arrayBuffer();
      try {
        await verifyBuffer(buffer, request.sha1, request.label);
      } catch {
        continue;
      }
      await opfs.writeFile(request.opfsPath, buffer);
      return { source: "opfs", size: buffer.byteLength };
    }

    if (this.localSource && request.localCandidates?.length) {
      const localFile = await this.localSource.getFile(request.localCandidates);
      if (localFile && (request.size === undefined || localFile.size === request.size)) {
        const buffer = await localFile.arrayBuffer();
        let localValid = true;
        try {
          await verifyBuffer(buffer, request.sha1, request.label);
        } catch {
          // A corrupt local copy should not poison the launch; fall through to Mojang.
          localValid = false;
        }
        if (localValid) {
          await opfs.writeFile(request.opfsPath, buffer);
          return { source: "local", size: buffer.byteLength };
        }
      }
    }

    if (!request.url) {
      throw new Error(`Falta ${request.label} y no tiene URL de descarga ni copia local (${request.opfsPath}).`);
    }

    const response = await fetchWithFallback(request.url, this.options);
    if (!response.ok) throw new Error(`HTTP ${response.status} al descargar ${request.label} (${request.url})`);
    const buffer = await readResponseToBuffer(response, onBytes);
    if (request.size !== undefined && buffer.byteLength !== request.size) {
      throw new Error(`Tamaño inesperado para ${request.label}: esperado ${request.size}, obtenido ${buffer.byteLength}`);
    }
    await verifyBuffer(buffer, request.sha1, request.label);
    await opfs.writeFile(request.opfsPath, buffer);
    return { source: "download", size: buffer.byteLength };
  }
}

export async function runPool<T>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length || 1)) }, async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      await worker(items[index], index);
    }
  });
  await Promise.all(workers);
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}
