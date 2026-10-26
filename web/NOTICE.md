# Third-party components used by WebPrism

WebPrism itself is distributed under the same license as this repository
(GPL-3.0-only), unless a file states otherwise.

## Runtime (loaded or downloaded separately, not committed here)

- **CheerpJ 4.3** (commercial/community license by Leaning Technologies) is
  loaded at runtime from `https://cjrtnc.leaningtech.com/4.3/loader.js`.
  Check Leaning Technologies' current terms before commercial deployments.
- **LWJGL 2.9.3 + gl4es WebAssembly natives** are downloaded by
  `scripts/fetch-lwjgl2.mjs` from Leaning Technologies' Browsercraft
  repository. Browsercraft is Apache-2.0, LWJGL is BSD-3-Clause and gl4es is
  MIT.
- **TeaVM/Eaglercraft-style clients** are never bundled. If you configure an
  AOT bundle URL, you are responsible for the rights to host and use it.

## Game files

Minecraft client JARs, libraries and assets are **never committed or
redistributed by WebPrism**. They are downloaded in the user's browser from
Mojang's official distribution endpoints (or read from a local installation
the user explicitly selects) and verified against Mojang's SHA-1 hashes.

Minecraft is a trademark of Mojang AB / Microsoft. This experimental project
is not affiliated with, endorsed by, or sponsored by Mojang, Microsoft, or the
Prism Launcher project.
