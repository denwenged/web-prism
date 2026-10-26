/*
 * WebPrism data service worker.
 *
 * CheerpJ exposes the web server root to Java as /app/. WebPrism stores the
 * downloads/cache in OPFS; this worker bridges the gap by serving
 *   /webprism-data/<path>
 * from OPFS "web-prism/<path>" with HTTP Range responses, so Java sees it as
 *   /app/webprism-data/<path>
 * without the server ever storing Mojang's files.
 */

const DATA_PREFIX = "/webprism-data/";
const OPFS_ROOT = "web-prism";

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith(DATA_PREFIX)) return;
  if (event.request.method !== "GET" && event.request.method !== "HEAD") return;
  event.respondWith(serveOpfsFile(event.request, url));
});

function contentTypeFor(path) {
  const lower = path.toLowerCase();
  if (lower.endsWith(".jar")) return "application/java-archive";
  if (lower.endsWith(".json")) return "application/json; charset=utf-8";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".ogg")) return "audio/ogg";
  if (lower.endsWith(".txt") || lower.endsWith(".cfg") || lower.endsWith(".log") || lower.endsWith(".properties")) {
    return "text/plain; charset=utf-8";
  }
  if (lower.endsWith(".wasm")) return "application/wasm";
  return "application/octet-stream";
}

function parseRange(header, size) {
  if (!header || !header.startsWith("bytes=")) return null;
  const firstRange = header.slice(6).split(",")[0].trim();
  const parts = firstRange.split("-");
  if (parts.length !== 2) return "invalid";
  const [rawStart, rawEnd] = parts;
  let start;
  let end;

  if (rawStart === "") {
    const suffix = Number.parseInt(rawEnd, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return "invalid";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number.parseInt(rawStart, 10);
    end = rawEnd === "" ? size - 1 : Number.parseInt(rawEnd, 10);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= size) {
    return "invalid";
  }
  return { start, end: Math.min(end, size - 1) };
}

async function resolveOpfsFile(segments) {
  const storageRoot = await navigator.storage.getDirectory();
  let dir = await storageRoot.getDirectoryHandle(OPFS_ROOT, { create: false });
  for (const segment of segments.slice(0, -1)) {
    dir = await dir.getDirectoryHandle(segment, { create: false });
  }
  const fileName = segments[segments.length - 1];
  const fileHandle = await dir.getFileHandle(fileName, { create: false });
  return fileHandle.getFile();
}

async function serveOpfsFile(request, url) {
  try {
    const encoded = url.pathname.slice(DATA_PREFIX.length);
    const segments = encoded.split("/").map((segment) => decodeURIComponent(segment));
    if (segments.length === 0 || segments.some((segment) => segment === "" || segment === "." || segment === ".." || segment.includes("\\"))) {
      return new Response("Invalid WebPrism data path\n", { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } });
    }

    const file = await resolveOpfsFile(segments);
    const relativePath = segments.join("/");
    const immutable = relativePath.startsWith("cache/assets/objects/") || relativePath.startsWith("cache/libraries/");
    const etag = `"${file.size}-${file.lastModified}"`;
    const headers = new Headers({
      "content-type": file.type || contentTypeFor(relativePath),
      "accept-ranges": "bytes",
      etag,
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    });

    if (request.headers.get("if-none-match") === etag) {
      return new Response(null, { status: 304, headers });
    }

    const range = parseRange(request.headers.get("range"), file.size);
    if (range === "invalid") {
      headers.set("content-range", `bytes */${file.size}`);
      return new Response(request.method === "HEAD" ? null : "Range not satisfiable\n", { status: 416, headers });
    }

    if (range) {
      headers.set("content-range", `bytes ${range.start}-${range.end}/${file.size}`);
      headers.set("content-length", String(range.end - range.start + 1));
      return new Response(request.method === "HEAD" ? null : file.slice(range.start, range.end + 1), { status: 206, headers });
    }

    headers.set("content-length", String(file.size));
    return new Response(request.method === "HEAD" ? null : file, { status: 200, headers });
  } catch (error) {
    const notFound = error && (error.name === "NotFoundError" || error.name === "TypeMismatchError");
    return new Response(notFound ? "WebPrism OPFS file not found\n" : `WebPrism OPFS error: ${error?.message ?? error}\n`, {
      status: notFound ? 404 : 500,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
}
