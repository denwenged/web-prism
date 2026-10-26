export const OPFS_ROOT_NAME = "web-prism";
export const DATA_HTTP_PREFIX = "/webprism-data";

export interface OpfsEntry {
  name: string;
  kind: "file" | "directory";
  path: string;
}

function normalizePath(path: string): string[] {
  const segments = path.split("/").map((segment) => segment.trim()).filter(Boolean);
  for (const segment of segments) {
    if (segment === "." || segment === ".." || segment.includes("\\") || segment.includes("\0")) {
      throw new Error(`Ruta OPFS no válida: ${path}`);
    }
  }
  return segments;
}

function joinPath(...parts: string[]): string {
  return parts.flatMap((part) => part.split("/").filter(Boolean)).join("/");
}

async function rootDir(create = true): Promise<FileSystemDirectoryHandle> {
  if (!navigator.storage?.getDirectory) {
    throw new Error("Este navegador no soporta OPFS (Origin Private File System). Usa Chromium/Chrome/Edge reciente.");
  }
  const originRoot = await navigator.storage.getDirectory();
  return originRoot.getDirectoryHandle(OPFS_ROOT_NAME, { create });
}

async function getDir(path: string, create = false): Promise<FileSystemDirectoryHandle> {
  let dir = await rootDir(create);
  for (const segment of normalizePath(path)) {
    dir = await dir.getDirectoryHandle(segment, { create });
  }
  return dir;
}

async function getFileHandle(path: string, create = false): Promise<FileSystemFileHandle> {
  const segments = normalizePath(path);
  if (segments.length === 0) throw new Error("La ruta OPFS no puede ser la raíz.");
  const fileName = segments[segments.length - 1];
  const dir = await getDir(segments.slice(0, -1).join("/"), create);
  return dir.getFileHandle(fileName, { create });
}

export function dataHttpPath(opfsPath: string): string {
  const encoded = normalizePath(opfsPath).map((segment) => encodeURIComponent(segment)).join("/");
  return `${DATA_HTTP_PREFIX}/${encoded}`;
}

export function cheerpjAppPath(opfsPath: string): string {
  return `/app${dataHttpPath(opfsPath)}`;
}

export const opfs = {
  join: joinPath,

  async ensureDir(path: string): Promise<void> {
    await getDir(path, true);
  },

  async exists(path: string): Promise<boolean> {
    try {
      await getFileHandle(path, false);
      return true;
    } catch {
      try {
        await getDir(path, false);
        return true;
      } catch {
        return false;
      }
    }
  },

  async fileExists(path: string): Promise<boolean> {
    try {
      await getFileHandle(path, false);
      return true;
    } catch {
      return false;
    }
  },

  async writeFile(path: string, data: Blob | ArrayBuffer | Uint8Array | string): Promise<void> {
    const handle = await getFileHandle(path, true);
    const writable = await (handle as FileSystemFileHandle & { createWritable(): Promise<FileSystemWritableFileStream> }).createWritable();
    try {
      const blob = typeof data === "string" ? new Blob([data], { type: "text/plain; charset=utf-8" }) : data instanceof Blob ? data : new Blob([data as BlobPart]);
      await writable.write(blob);
    } finally {
      await writable.close();
    }
  },

  async writeText(path: string, text: string): Promise<void> {
    await this.writeFile(path, text);
  },

  async writeJson(path: string, value: unknown): Promise<void> {
    await this.writeText(path, `${JSON.stringify(value, null, 2)}\n`);
  },

  async readFile(path: string): Promise<File> {
    const handle = await getFileHandle(path, false);
    return handle.getFile();
  },

  async readOptionalFile(path: string): Promise<File | null> {
    try {
      return await this.readFile(path);
    } catch {
      return null;
    }
  },

  async readText(path: string): Promise<string> {
    return (await this.readFile(path)).text();
  },

  async readOptionalText(path: string): Promise<string | null> {
    const file = await this.readOptionalFile(path);
    return file ? file.text() : null;
  },

  async readJson<T>(path: string): Promise<T> {
    return JSON.parse(await this.readText(path)) as T;
  },

  async readOptionalJson<T>(path: string): Promise<T | null> {
    const text = await this.readOptionalText(path);
    if (!text) return null;
    return JSON.parse(text) as T;
  },

  async stat(path: string): Promise<{ size: number; lastModified: number } | null> {
    const file = await this.readOptionalFile(path);
    return file ? { size: file.size, lastModified: file.lastModified } : null;
  },

  async list(path = ""): Promise<OpfsEntry[]> {
    const entries: OpfsEntry[] = [];
    let dir: FileSystemDirectoryHandle;
    try {
      dir = await getDir(path, false);
    } catch {
      return entries;
    }
    const iterable = (dir as FileSystemDirectoryHandle & { values(): AsyncIterable<FileSystemHandle> }).values();
    for await (const handle of iterable) {
      entries.push({ name: handle.name, kind: handle.kind, path: joinPath(path, handle.name) });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return entries;
  },

  async walk(path = ""): Promise<string[]> {
    const out: string[] = [];
    const visit = async (current: string): Promise<void> => {
      for (const entry of await this.list(current)) {
        if (entry.kind === "directory") await visit(entry.path);
        else out.push(entry.path);
      }
    };
    await visit(path);
    return out;
  },

  async remove(path: string): Promise<void> {
    const segments = normalizePath(path);
    if (segments.length === 0) throw new Error("No se puede borrar la raíz OPFS.");
    const parent = await getDir(segments.slice(0, -1).join("/"), false);
    await parent.removeEntry(segments[segments.length - 1], { recursive: true });
  },

  async estimate(): Promise<{ usage?: number; quota?: number }> {
    if (!navigator.storage?.estimate) return {};
    return navigator.storage.estimate();
  },

  async requestPersistence(): Promise<boolean> {
    try {
      if (!navigator.storage?.persist) return false;
      if (await navigator.storage.persisted()) return true;
      return navigator.storage.persist();
    } catch {
      return false;
    }
  },
};
