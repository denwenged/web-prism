# WebPrism (experimental)

WebPrism es un launcher de **Minecraft: Java Edition que corre entero en el
navegador**. No sustituye al Prism Launcher de escritorio de este repositorio:
vive en `web/` como un subproyecto independiente y reaprovecha los formatos de
instancia de Prism para que una misma instancia pueda viajar entre el
escritorio y la web.

> Estado: **experimental**. La parte de launcher (versiones, instancias,
> descargas verificadas, importación/exportación local) es funcional. La parte
> de ejecución depende de hasta dónde llega hoy una JVM en WebAssembly con
> gráficos LWJGL; ver la matriz de compatibilidad más abajo.

## La idea en una frase

Pon un nombre de usuario, elige una versión y pulsa **Jugar**: el navegador
descarga el cliente oficial desde Mojang (o lo lee de tu carpeta local), lo
verifica con SHA-1, lo guarda en OPFS y lo ejecuta en una JVM WebAssembly.
Si tienes una instalación real, puedes seleccionar tu carpeta de Prism o tu
`.minecraft` y reutilizar versiones, librerías, assets, mundos, mods y
configuración.

## Arranque rápido

Requisitos: Node.js 20+ y un navegador Chromium reciente para las funciones de
carpetas locales (File System Access API). El launcher necesita un contexto
seguro: HTTPS o `localhost`.

```bash
cd web
npm install
npm run setup:runtime   # descarga los nativos LWJGL2/wasm (no van en Git)
npm run dev             # http://localhost:5173
```

Producción:

```bash
npm run build
npm run serve           # sirve dist/ en :4173 con Range + proxy CORS de respaldo
```

Tests del núcleo (formatos Prism, reglas de Mojang, UUID offline):

```bash
npm test
```

## Cómo funciona

```text
┌─────────────────────────────────────────────────────────────────────┐
│ Navegador                                                           │
│                                                                     │
│  UI (instancias Prism en OPFS)                                      │
│        │                                                            │
│        ├─ Manifiesto + perfiles de Mojang ──► resolvedor compatible │
│        │    (inheritsFrom, reglas, librerías, assets, argumentos,  │
│        │     parches patches/*.json de Prism)                       │
│        │                                                            │
│        ├─ OPFS: cache/versions|libraries|assets + instances/<id>/   │
│        │        ▲                    │                              │
│        │        │                    ▼                              │
│        │   import/export      Service Worker /webprism-data/*       │
│        │   File System              │  (Range 206 desde OPFS)       │
│        │   Access API               ▼                              │
│  Tu disco real               CheerpJ /app/webprism-data/*           │
│  (.minecraft / Prism)        JVM wasm ─► gameDir en /files          │
│                                     ▲                               │
│             sync JVM→OPFS→disco ────┘                               │
└─────────────────────────────────────────────────────────────────────┘
```

Piezas clave:

- **Instancias Prism de verdad.** Cada instancia web es una carpeta con
  `instance.cfg`, `mmc-pack.json` (formatVersion 1), `patches/` y
  `minecraft/` (o `.minecraft/`), igual que en el launcher de escritorio. El
  único archivo extra es `webprism.json`, que Prism ignora.
- **Resolvedor tipo launcher.** Lee el manifiesto oficial de Mojang, sigue
  `inheritsFrom` (perfiles Forge/Fabric de una `.minecraft`), evalúa reglas
  de SO/funciones, fusiona librerías Maven, descarga el cliente y los assets
  verificando SHA-1, reconstruye assets `virtual`/`map_to_resources` y
  genera el plan de lanzamiento (classpath + argumentos + propiedades JVM).
  También aplica un subconjunto de los parches OneSix de Prism
  (`libraries`, `+libraries`, `+tweakers`, `+jvmArgs`, `mainJar`, `mainClass`).
- **OPFS + Service Worker = disco virtual HTTP.** CheerpJ ve el servidor como
  `/app/`. El Service Worker responde `/webprism-data/*` desde OPFS con
  peticiones Range, así que la JVM lee los JAR/assets que el navegador
  descargó sin que ningún servidor tenga que alojar archivos de Mojang.
- **Backend JVM (CheerpJ).** Ejecuta bytecode Java real (8/11/17) en
  WebAssembly. Los JAR de LWJGL2 se sustituyen por la build 2.9.3
  acompañada de nativos wasm + gl4es (OpenGL→GLES/WebGL). El `gameDir` vive en
  el `/files` persistente de CheerpJ y se sincroniza de vuelta a OPFS al
  salir; desde ahí puedes exportarlo a tu disco.
- **Backend AOT opcional.** Para versiones con port compilado (TeaVM /
  Eaglercraft) puedes configurar la URL de **tu propio bundle alojado**. El
  modo automático prefiere AOT solo en instancias vanilla; con loaders o mods
  usa la JVM. WebPrism no incluye ni redistribuye bundles de terceros.
- **Carpeta local.** Con File System Access API puedes importar una
  instancia Prism, una carpeta raíz de instancias o una `.minecraft`
  completa. La caché compartida (`versions/`, `libraries/`, `assets/`) se
  vincula y se lee **bajo demanda**: solo se copia a OPFS lo que la versión
  elegida necesita. Los handles se guardan en IndexedDB para poder pedir el
  permiso otra vez y **exportar/sincronizar** la instancia de vuelta al disco.

## Compatibilidad (honesta)

| Objetivo | Estado |
| --- | --- |
| Resolver/descargar cualquier versión del manifiesto | ✅ Cliente, librerías y assets verificados por SHA-1 |
| Instancias Prism ↔ web (import/export) | ✅ `instance.cfg`, `mmc-pack.json`, `patches/`, mundos, mods, config |
| Minecraft 1.2.5 en JVM wasm | ✅ Ruta demostrada (la misma pila que Browsercraft) |
| Era LWJGL2 (hasta 1.12.2) vanilla | 🧪 Experimental: puede arrancar; cada versión puede necesitar parches de runtime |
| Mods `.jar` / loaders legacy | 🧪 Los mods se sincronizan al `gameDir` y los perfiles `inheritsFrom`/patches se resuelven; la compatibilidad depende de la JVM/nativos wasm |
| 1.13+ (LWJGL3 + GLFW/OpenAL) | ❌ Bloqueado: falta una capa GLFW/OpenAL en WebAssembly |
| Java 21+ (1.20.5+) | ❌ CheerpJ ofrece runtimes 8/11/17 |
| Versiones con port AOT (p. ej. 1.8.8) | ✅ Si configuras un bundle TeaVM/Eagler alojado por ti |
| Multijugador | ❌ Sin cuentas Microsoft y sin relay WebSocket→TCP; solo local/offline |
| Login Microsoft | ❌ Solo perfil offline por nombre (UUID v3 como Prism) |

El launcher lo dice antes de descargar cientos de MB: al **Resolver perfil**
muestra Java requerido, librerías, nativos detectados y el motivo exacto de
cualquier bloqueo.

## Uso paso a paso

1. Escribe un nombre de usuario (3–16 caracteres) y acepta el EULA.
2. Elige una versión de la lista o escribe un ID de perfil personalizado
   (p. ej. uno de Forge/Fabric presente en tu `.minecraft`).
3. Pulsa **Jugar**. Si no existe instancia, se crea una automáticamente.
   Para inspeccionar antes, usa **Resolver perfil** y **Descargar y preparar**.
4. Para usar tu instalación real: **Importar instancia(s) Prism…** o
   **Crear desde .minecraft…**, y opcionalmente **Vincular caché…** con la
   carpeta que contiene `versions/`, `libraries/` y `assets/` (sirve tanto
   `.minecraft` como la carpeta de datos de Prism).
5. Al salir del juego, la partida se sincroniza a OPFS. Con
   **Exportar / sincronizar a disco…** vuelve a tu carpeta; Prism de
   escritorio reconocerá la instancia exportada.

Consejos de rendimiento: una JVM wasm es monohilo y comparte CPU entre
renderizado y servidor integrado. WebPrism crea un `options.txt` conservador
(distancia 4, 30 fps, sin VBO/FBO) solo si no existe uno. Arrancar puede
tardar minutos en la primera vez.

## Despliegue

- Sirve la app desde la **raíz** del origen por HTTPS. Ejecuta
  `npm run setup:runtime` en el build para que existan los nativos LWJGL2.
- El servidor debe soportar **HTTP Range** para `/lwjgl/*` (lo hace
  `server.mjs` y Vite). CheerpJ lee los JAR por bloques.
- **No envíes `Cross-Origin-Embedder-Policy`** (COEP): el frame auxiliar de
  CheerpJ queda bloqueado y el arranque se cuelga en silencio. Sí enviamos
  `Cross-Origin-Opener-Policy: same-origin`.
- Las descargas intentan primero ir directas a Mojang. Si un CDN no manda
  CORS, el launcher reintenta por `/api/proxy?url=…`, un proxy con
  allow-list incluido en el plugin de Vite y en `server.mjs`. En un hosting
  100% estático puedes cambiar el campo “Proxy CORS” por tu propio worker.
- CheerpJ se carga desde el CDN de Leaning Technologies. Revisa sus
  términos (licencia comunitaria/comercial) antes de un despliegue público.

## Estructura

```text
web/
├─ index.html / src/main.ts / src/style.css   UI del launcher
├─ src/mojang.ts                              Perfiles, reglas, merges, compatibilidad
├─ src/launcherService.ts                     Descargas + plan de lanzamiento
├─ src/prism.ts                               instance.cfg y mmc-pack.json
├─ src/opfs.ts · src/idb.ts                   Almacenamiento y handles persistidos
├─ src/localFolder.ts                         File System Access: detectar/importar/exportar
├─ src/cheerpj.ts                             Adaptador JVM + sync /files ↔ OPFS
├─ public/sw.js                               OPFS → HTTP Range para CheerpJ /app
├─ scripts/fetch-lwjgl2.mjs                   Runtime LWJGL2 wasm (Browsercraft)
├─ vite.config.ts · server.mjs                Dev/prod: Range, cabeceras y proxy CORS
└─ NOTICE.md                                  Licencias de terceros
```

## Roadmap natural

1. Resolvedor de componentes contra el servidor *meta* de Prism (instalar
   Fabric/Forge/Quilt/NeoForge desde la propia web, no solo desde parches ya
   presentes).
2. Capa GLFW + OpenAL en WebAssembly para desbloquear 1.13–1.16.5 (Java 8) y
   después 1.17+ con CheerpJ 17.
3. Parches de runtime por versión (como hacen los ports comunitarios para
   1.12.2) servidos como “componentes web” opcionales.
4. Relay WebSocket→TCP y lista de servidores; autenticación Microsoft
   opcional tras un backend mínimo.
5. Bundles AOT empaquetados como componentes instalables con procedencia y
   hashes claros.

## Legal

Proyecto experimental no oficial, sin afiliación con Mojang, Microsoft ni el
proyecto Prism Launcher. Minecraft requiere una licencia válida. WebPrism
**no redistribuye** el cliente ni los assets: se descargan en tu navegador
desde los endpoints oficiales de Mojang o se leen de una instalación tuya que
seleccionas explícitamente. Consulta `NOTICE.md`.
