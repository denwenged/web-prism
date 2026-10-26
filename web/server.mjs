// Minimal production server for WebPrism.
//
// It serves dist/ with HTTP Range support (CheerpJ random-access reads JARs),
// exposes the same allow-listed CORS fallback proxy as the Vite plugin, and
// deliberately does not send COEP (it breaks CheerpJ's helper frame).

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("./dist/", import.meta.url));
const port = Number.parseInt(process.env.PORT ?? "4173", 10);
const host = process.env.HOST ?? "0.0.0.0";

const MIME = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".wasm", "application/wasm"],
  [".jar", "application/java-archive"],
  [".so", "application/octet-stream"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".ico", "image/x-icon"],
  [".txt", "text/plain; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
]);

const ALLOWED_PROXY_SUFFIXES = [
  "mojang.com",
  "minecraft.net",
  "minecraftforge.net",
  "maven.minecraftforge.net",
  "files.minecraftforge.net",
  "neoforged.net",
  "fabricmc.net",
  "quiltmc.org",
  "spongepowered.org",
  "maven.apache.org",
  "repo1.maven.org",
  "repo.maven.apache.org",
  "maven-central.storage-download.googleapis.com",
  "libraries.minecraft.net",
];

function allowedProxyTarget(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return null;
    const hostName = url.hostname.toLowerCase();
    return ALLOWED_PROXY_SUFFIXES.some((suffix) => hostName === suffix || hostName.endsWith(`.${suffix}`)) ? url : null;
  } catch {
    return null;
  }
}

async function proxy(req, res, requestUrl) {
  const target = allowedProxyTarget(requestUrl.searchParams.get("url") ?? "");
  if (!target) {
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    res.end("Missing or disallowed ?url= proxy target\n");
    return;
  }

  const headers = new Headers({ "user-agent": "WebPrism/0.1" });
  if (req.headers.range) headers.set("range", req.headers.range);
  if (req.headers["if-none-match"]) headers.set("if-none-match", req.headers["if-none-match"]);
  if (req.headers["if-modified-since"]) headers.set("if-modified-since", req.headers["if-modified-since"]);

  try {
    const upstream = await fetch(target, { headers, redirect: "follow" });
    const responseHeaders = { "cache-control": "public, max-age=3600" };
    for (const name of ["content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified"]) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders[name] = value;
    }
    res.writeHead(upstream.status, responseHeaders);
    if (!upstream.body) {
      res.end();
      return;
    }
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (error) {
    res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    res.end(`Upstream proxy error: ${error?.message ?? error}\n`);
  }
}

function parseRange(header, size) {
  if (!header?.startsWith("bytes=")) return null;
  const [rawStart = "", rawEnd = ""] = header.slice(6).split(",", 1)[0].split("-");
  let start;
  let end;
  if (rawStart === "") {
    const suffix = Number.parseInt(rawEnd, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number.parseInt(rawStart, 10);
    end = rawEnd === "" ? size - 1 : Number.parseInt(rawEnd, 10);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= size) return "invalid";
  return { start, end: Math.min(end, size - 1) };
}

async function serveFile(req, res, filePath) {
  const info = await stat(filePath);
  if (!info.isFile()) throw Object.assign(new Error("not found"), { code: "ENOENT" });

  const headers = {
    "content-type": MIME.get(extname(filePath).toLowerCase()) ?? "application/octet-stream",
    "accept-ranges": "bytes",
    etag: `"${info.size}-${Math.floor(info.mtimeMs)}"`,
    "last-modified": info.mtime.toUTCString(),
    "cache-control": filePath.endsWith("index.html") || filePath.endsWith("sw.js") ? "no-cache" : "public, max-age=3600",
    "cross-origin-opener-policy": "same-origin",
    "x-content-type-options": "nosniff",
  };

  if (req.headers["if-none-match"] === headers.etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }

  const range = parseRange(req.headers.range, info.size);
  if (range === "invalid") {
    res.writeHead(416, { ...headers, "content-range": `bytes */${info.size}` });
    res.end();
    return;
  }

  if (range) {
    res.writeHead(206, {
      ...headers,
      "content-range": `bytes ${range.start}-${range.end}/${info.size}`,
      "content-length": String(range.end - range.start + 1),
    });
    if (req.method === "HEAD") res.end();
    else createReadStream(filePath, range).pipe(res);
    return;
  }

  res.writeHead(200, { ...headers, "content-length": String(info.size) });
  if (req.method === "HEAD") res.end();
  else createReadStream(filePath).pipe(res);
}

const server = createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url ?? "/", "http://localhost");

    if (requestUrl.pathname === "/api/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, app: "web-prism" }));
      return;
    }
    if (requestUrl.pathname === "/api/proxy") {
      await proxy(req, res, requestUrl);
      return;
    }
    if (requestUrl.pathname.startsWith("/webprism-data/")) {
      // These URLs are answered by the Service Worker from OPFS. If we got a
      // real network request, the worker is not controlling the page yet.
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("WebPrism data is served from OPFS by the service worker; it is not active for this request.\n");
      return;
    }

    const decoded = decodeURIComponent(requestUrl.pathname);
    const safePath = normalize(decoded).replace(/^(\.\.[/\\])+/, "").replace(/^[/\\]+/, "");
    const filePath = join(root, safePath === "" ? "index.html" : safePath);

    try {
      await serveFile(req, res, filePath);
    } catch (error) {
      const acceptsHtml = (req.headers.accept ?? "").includes("text/html");
      if (error?.code === "ENOENT" && acceptsHtml && !extname(safePath)) {
        await serveFile(req, res, join(root, "index.html"));
      } else {
        throw error;
      }
    }
  } catch (error) {
    if (!res.headersSent) {
      res.writeHead(error?.code === "ENOENT" ? 404 : 500, { "content-type": "text/plain; charset=utf-8" });
    }
    res.end(error?.code === "ENOENT" ? "Not found\n" : `Server error: ${error?.message ?? error}\n`);
  }
});

server.listen(port, host, () => {
  console.log(`WebPrism listening on http://${host}:${port}`);
});
