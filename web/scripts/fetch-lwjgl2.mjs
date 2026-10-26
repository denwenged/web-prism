// Downloads the LWJGL 2 WebAssembly runtime used by the CheerpJ backend.
//
// The binaries are intentionally not committed to this repository. They come
// from Leaning Technologies' Apache-2.0 Browsercraft project (LWJGL is
// BSD-3-Clause and gl4es is MIT; see ../NOTICE.md). No Minecraft files are
// downloaded by this script.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const defaultRef = process.env.BROWSERCRAFT_REF ?? "main";

const files = [
  { source: "static/lwjgl/lwjgl-2.9.3.jar", dest: "public/lwjgl/lwjgl-2.9.3.jar", expectedSize: 1_053_471 },
  { source: "static/lwjgl/lwjgl_util-2.9.3.jar", dest: "public/lwjgl/lwjgl_util-2.9.3.jar", expectedSize: 173_911 },
  { source: "static/lwjgl/libraries/gl4es.wasm", dest: "public/lwjgl/libraries/gl4es.wasm", expectedSize: 2_724_913 },
  { source: "static/lwjgl/libraries/liblwjgl.so", dest: "public/lwjgl/libraries/liblwjgl.so", expectedSize: 1_358_094 },
  { source: "static/lwjgl/libraries/lwjgl.js", dest: "public/lwjgl/libraries/lwjgl.js", expectedSize: 123 },
];

async function fetchFrom(url, headers = {}) {
  const response = await fetch(url, {
    headers: { "user-agent": "WebPrism runtime fetcher", ...headers },
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function fetchBrowsercraftFile(source) {
  const attempts = [
    () => fetchFrom(`https://raw.githubusercontent.com/leaningtech/browsercraft/${defaultRef}/${source}`),
    () =>
      fetchFrom(`https://api.github.com/repos/leaningtech/browsercraft/contents/${source}?ref=${encodeURIComponent(defaultRef)}`, {
        accept: "application/vnd.github.raw+json",
      }),
  ];

  let lastError;
  for (const attempt of attempts) {
    try {
      return await attempt();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

for (const file of files) {
  const destination = join(projectRoot, file.dest);
  await mkdir(dirname(destination), { recursive: true });
  process.stdout.write(`Downloading ${file.source} ... `);
  const bytes = await fetchBrowsercraftFile(file.source);
  await writeFile(destination, bytes);
  const sizeNote = bytes.length === file.expectedSize ? "ok" : `ok (size ${bytes.length}, expected ${file.expectedSize}; upstream may have changed)`;
  console.log(sizeNote);
}

await writeFile(
  join(projectRoot, "public/lwjgl/RUNTIME-NOTICE.txt"),
  [
    "LWJGL 2 WebAssembly runtime for WebPrism",
    "",
    "Downloaded by scripts/fetch-lwjgl2.mjs from Leaning Technologies' Browsercraft:",
    "https://github.com/leaningtech/browsercraft",
    "",
    "Browsercraft: Apache-2.0",
    "LWJGL 2: BSD-3-Clause",
    "gl4es: MIT",
    "",
    "No Minecraft game files are included in this directory.",
    "",
  ].join("\n"),
);

console.log("LWJGL2 runtime ready in public/lwjgl/");
