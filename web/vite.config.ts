import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { defineConfig, type Plugin } from "vite";

/**
 * Mojang/modloader file proxy used only as a CORS fallback.
 *
 * The browser first tries to download files directly. If a CDN does not send
 * CORS headers, the launcher retries through /api/proxy. The allow-list keeps
 * this from becoming an open proxy.
 */
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
  "prismlauncher.org",
  "modrinth.com",
];

function isAllowedProxyTarget(raw: string): URL | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return null;
    const host = url.hostname.toLowerCase();
    return ALLOWED_PROXY_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`)) ? url : null;
  } catch {
    return null;
  }
}

async function proxyRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestUrl = new URL(req.url ?? "/", "http://localhost");
  const targetRaw = requestUrl.searchParams.get("url");
  const target = targetRaw ? isAllowedProxyTarget(targetRaw) : null;

  if (!target) {
    res.statusCode = 400;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end("Missing or disallowed ?url= proxy target\n");
    return;
  }

  const headers = new Headers();
  headers.set("user-agent", "WebPrism/0.1 (+https://github.com/PrismLauncher/PrismLauncher)");
  const range = req.headers.range;
  if (typeof range === "string") headers.set("range", range);
  const ifNoneMatch = req.headers["if-none-match"];
  if (typeof ifNoneMatch === "string") headers.set("if-none-match", ifNoneMatch);
  const ifModifiedSince = req.headers["if-modified-since"];
  if (typeof ifModifiedSince === "string") headers.set("if-modified-since", ifModifiedSince);

  try {
    const upstream = await fetch(target, { headers, redirect: "follow" });
    res.statusCode = upstream.status;
    for (const name of ["content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified"]) {
      const value = upstream.headers.get(name);
      if (value) res.setHeader(name, value);
    }
    res.setHeader("cache-control", "public, max-age=3600");

    if (!upstream.body) {
      res.end();
      return;
    }
    Readable.fromWeb(upstream.body as never).pipe(res);
  } catch (error) {
    res.statusCode = 502;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end(`Upstream proxy error: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

function webPrismServerPlugin(): Plugin {
  const configure = (server: { middlewares: { use: (path: string, handler: (req: IncomingMessage, res: ServerResponse, next: () => void) => void) => void } }) => {
    server.middlewares.use("/api/proxy", (req, res) => void proxyRequest(req, res));
    server.middlewares.use("/api/health", (_req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, app: "web-prism" }));
    });
  };

  return {
    name: "web-prism-server",
    configureServer: configure,
    configurePreviewServer: configure,
  };
}

const headers = {
  // Do not add Cross-Origin-Embedder-Policy here: CheerpJ 4.3 loads a
  // cross-origin helper frame and COEP can make cheerpjRunMain hang silently.
  "Cross-Origin-Opener-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
};

export default defineConfig({
  plugins: [webPrismServerPlugin()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    allowedHosts: true,
    headers,
  },
  preview: {
    host: "0.0.0.0",
    port: 5173,
    allowedHosts: true,
    headers,
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
});
