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

Pulsa **Añadir instancia**, elige Minecraft en una lista y —si quieres—
Forge, NeoForge, Fabric, Quilt o LiteLoader en otra lista. Después pulsa
**Crear e iniciar**: el navegador descarga el cliente oficial desde Mojang
(o lo lee de tu carpeta local), lo verifica con SHA-1, lo guarda en OPFS y lo
ejecuta en una JVM WebAssembly cuando el runtime lo permite. Desde
**Editar** puedes instalar mods, paquetes de recursos, shaders y paquetes de
datos con la misma lógica de listas que usa Prism.

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

Tests del núcleo (formatos Prism, reglas de Mojang, Prism Meta, Modrinth y UUID offline):

```bash
npm test
```

## Cómo funciona

```text
┌─────────────────────────────────────────────────────────────────────┐
│ Navegador                                                           │
│                                                                     │
│  UI tipo Prism/MainWindow (listas + dialogo de instancia)          │
│        │                                                            │
│        ├─ Prism Meta ──► loaders/dependencias ──► mmc-pack + patches │
│        ├─ Modrinth ──► mods/resourcepacks/shaders/datapacks          │
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

- **Instancias Prism de verdad.** La ventana principal imita el MainWindow
  de Prism: barra de menús/herramientas, lista central de instancias, barra
  lateral de acciones con **Iniciar** y barra de progreso. Cada instancia web
  es una carpeta con `instance.cfg`, `mmc-pack.json` (formatVersion 1),
  `patches/` y `minecraft/` (o `.minecraft/`), igual que en el launcher de
  escritorio. Los archivos extra son `webprism.json` y los sidecars de
  procedencia en `minecraft/.webprism-resources/`, que Prism ignora.
- **Loaders desde Prism Meta.** El diálogo “Nueva instancia” y la página
  **Versión** leen `https://meta.prismlauncher.org/v1/` (configurable):
  filtran NeoForge, Forge, Fabric, Quilt y LiteLoader por la versión de
  Minecraft, marcan la recomendada, verifican el SHA-256 del patch cuando el
  índice lo trae, resuelven dependencias de componentes (por ejemplo
  Fabric → Intermediary) y escriben `mmc-pack.json` + `patches/<uid>.json`.
  Las instancias importadas sin patch local intentan descargarlo de forma
  perezosa al comprobar/iniciar.
- **Contenido como en Prism.** **Editar** abre páginas de **Versión, Mods,
  Resource Packs, Shader Packs, Data Packs, Mundos, Juego, Registro y
  Ajustes**. Cada página de contenido lista lo instalado y permite
  **Descargar…** desde Modrinth (filtrado por versión y loader, con
  dependencias requeridas y verificación SHA-512/SHA-1), **Añadir archivo…**,
  activar/desactivar con `.disabled` y eliminar. Los Data Packs pueden ir a
  la carpeta global de Prism o a `saves/<mundo>/datapacks/`.
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

Poder instalar un loader moderno no significa que el navegador ya pueda
ejecutarlo: la lista de instancias distingue **Recomendado**,
**Experimental** y **Gestionar/exportar**. Al **Comprobar compatibilidad** (o
al pulsar Iniciar) se muestran Java requerido, librerías, nativos detectados
y el motivo exacto de cualquier bloqueo.

## Uso paso a paso

1. Pulsa **Añadir instancia**. Elige la versión de Minecraft en la lista
   (los checkboxes separan releases, snapshots, betas, alfas, experimentos y
   perfiles locales).
2. En la segunda lista elige el loader —Ninguno, NeoForge, Forge, Fabric,
   Quilt o LiteLoader— y después su versión. La recomendada por Prism Meta
   viene preseleccionada. El campo de “ID de perfil” queda solo como opción
   avanzada para perfiles ya importados.
3. Pulsa **Crear e iniciar**. La primera vez WebPrism abre la cuenta offline:
   escribe un nombre (3–16 caracteres), acepta el EULA y pulsa otra vez el
   gran botón **Iniciar**. Doble clic en una instancia también la inicia.
4. Para mods y packs: selecciona la instancia → **Editar** → **Mods** (o
   Resource Packs / Shader Packs / Data Packs) → **Descargar…**. El catálogo
   ya viene filtrado por la versión y el loader de la instancia.
5. Para usar tu instalación real usa **Carpetas**: importar una instancia
   Prism, importar `.minecraft` (si hay varios perfiles, se eligen en una
   lista) o vincular la caché con `versions/`, `libraries/` y `assets/`.
6. Al salir del juego, la partida se sincroniza a OPFS. **Exportar a
   Prism…** la escribe de vuelta en tu carpeta; Prism de escritorio la
   reconocerá.

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
- Las descargas intentan primero ir directas a Mojang, Prism Meta o
  Modrinth. Si un CDN no manda CORS, el launcher reintenta por
  `/api/proxy?url=…`, un proxy con allow-list incluido en el plugin de Vite y
  en `server.mjs` (incluye los dominios de Mojang, Prism, loaders y Modrinth).
  En un hosting 100% estático puedes cambiar el campo “Proxy CORS” por tu
  propio worker.
- CheerpJ se carga desde el CDN de Leaning Technologies. Revisa sus
  términos (licencia comunitaria/comercial) antes de un despliegue público.

## Estructura

```text
web/
├─ index.html / src/main.ts / src/style.css   UI tipo Prism (listas, dialogos, Edit)
├─ src/prismMeta.ts                           Loaders y dependencias desde Prism Meta
├─ src/resources.ts · src/modrinth.ts         Contenido instalado + descarga rápida
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

1. Capa GLFW + OpenAL en WebAssembly para desbloquear 1.13–1.16.5 (Java 8) y
   después 1.17+ con CheerpJ 17; procesadores completos de Forge/NeoForge.
2. Parches de runtime por versión (como hacen los ports comunitarios para
   1.12.2) servidos como “componentes web” opcionales.
3. Importación de modpacks (`.mrpack` y ZIP de Prism) y más proveedores de
   contenido cuando tengan una API usable desde el navegador sin claves.
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
