export interface MojangManifestVersion {
  id: string;
  type: string;
  url: string;
  time?: string;
  releaseTime?: string;
  sha1?: string;
  complianceLevel?: number;
}

export interface MojangVersionManifest {
  latest: { release: string; snapshot: string };
  versions: MojangManifestVersion[];
}

export interface DownloadInfo {
  url: string;
  sha1?: string;
  size?: number;
  path?: string;
}

export interface MojangRule {
  action: "allow" | "disallow";
  os?: { name?: string; version?: string; arch?: string };
  features?: Record<string, boolean>;
}

export type ArgumentValue = string | { rules?: MojangRule[]; value: string | string[] };

export interface LibraryJson {
  name: string;
  url?: string;
  downloads?: {
    artifact?: DownloadInfo;
    classifiers?: Record<string, DownloadInfo>;
  };
  natives?: Record<string, string>;
  rules?: MojangRule[];
  extract?: { exclude?: string[] };
  hint?: string;
  filename?: string;
  [key: string]: unknown;
}

export interface AssetIndexInfo extends Partial<DownloadInfo> {
  id: string;
  totalSize?: number;
}

export interface VersionJson {
  id: string;
  inheritsFrom?: string;
  type?: string;
  mainClass?: string;
  appletClass?: string;
  minecraftArguments?: string;
  arguments?: { game?: ArgumentValue[]; jvm?: ArgumentValue[] };
  libraries?: LibraryJson[];
  downloads?: Record<string, DownloadInfo>;
  assetIndex?: AssetIndexInfo;
  assets?: string;
  javaVersion?: { component?: string; majorVersion?: number };
  compatibleJavaMajors?: number[];
  releaseTime?: string;
  time?: string;
  [key: string]: unknown;
}

export interface PrismMetaRequirement {
  uid: string;
  equals?: string;
  suggests?: string;
}

export interface PrismPatchJson extends VersionJson {
  uid?: string;
  fileId?: string;
  version?: string;
  name?: string;
  order?: number;
  requires?: PrismMetaRequirement[];
  conflicts?: PrismMetaRequirement[];
  mcVersion?: string;
  "+libraries"?: LibraryJson[];
  "+tweakers"?: string[];
  "+traits"?: string[];
  "+jvmArgs"?: string[];
  "+agents"?: Array<LibraryJson & { argument?: string }>;
  mavenFiles?: LibraryJson[];
  jarMods?: LibraryJson[];
  mods?: LibraryJson[];
  mainJar?: LibraryJson;
}

export interface ResolvedProfile {
  id: string;
  /** Version that supplied downloads.client (the real Minecraft version for inherited profiles). */
  clientVersionId: string;
  type: string;
  mainClass: string;
  appletClass?: string;
  minecraftArguments?: string;
  arguments?: { game: ArgumentValue[]; jvm: ArgumentValue[] };
  libraries: LibraryJson[];
  clientDownload?: DownloadInfo;
  mainJarLibrary?: LibraryJson;
  assetIndex?: AssetIndexInfo;
  javaMajor: number;
  tweakers: string[];
  extraJvmArgs: string[];
  traits: string[];
  sourceChain: string[];
  warnings: string[];
}

export interface RuleContext {
  osName: string;
  osVersion: string;
  osArch: string;
  features: Record<string, boolean>;
}

export function webRuleContext(hasCustomResolution = true): RuleContext {
  return {
    // CheerpJ presents a Linux-like environment to Java code.
    osName: "linux",
    osVersion: "",
    osArch: "x86_64",
    features: {
      is_demo_user: false,
      has_custom_resolution: hasCustomResolution,
      has_quick_plays_support: false,
      is_quick_play_singleplayer: false,
      is_quick_play_multiplayer: false,
      is_quick_play_realms: false,
    },
  };
}

function ruleMatches(rule: MojangRule, context: RuleContext): boolean {
  if (rule.os) {
    if (rule.os.name && rule.os.name !== context.osName) return false;
    if (rule.os.arch && rule.os.arch !== context.osArch) return false;
    if (rule.os.version) {
      try {
        if (!new RegExp(rule.os.version).test(context.osVersion)) return false;
      } catch {
        return false;
      }
    }
  }
  if (rule.features) {
    for (const [feature, expected] of Object.entries(rule.features)) {
      if ((context.features[feature] ?? false) !== expected) return false;
    }
  }
  return true;
}

export function evaluateRules(rules: MojangRule[] | undefined, context: RuleContext): boolean {
  if (!rules || rules.length === 0) return true;
  let allowed: boolean | undefined;
  for (const rule of rules) {
    if (ruleMatches(rule, context)) allowed = rule.action === "allow";
  }
  return allowed ?? false;
}

export function expandArguments(values: ArgumentValue[] | undefined, context: RuleContext): string[] {
  const out: string[] = [];
  for (const value of values ?? []) {
    if (typeof value === "string") {
      out.push(value);
      continue;
    }
    if (!evaluateRules(value.rules, context)) continue;
    if (Array.isArray(value.value)) out.push(...value.value);
    else out.push(value.value);
  }
  return out;
}

export function tokenizeLegacyArguments(input: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  let escaped = false;

  for (const ch of input) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && /\s/.test(ch)) {
      if (current !== "") {
        out.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (escaped) current += "\\";
  if (current !== "") out.push(current);
  return out;
}

export function substituteArguments(args: string[], substitutions: Record<string, string>): string[] {
  return args.map((arg) =>
    arg.replace(/\$\{([^}]+)\}/g, (match, key: string) => substitutions[key] ?? match).replace(/\$\{([^}]+)\}/g, (match, key: string) => substitutions[key] ?? match),
  );
}

export interface GradleSpecifier {
  group: string;
  artifact: string;
  version: string;
  classifier?: string;
  extension: string;
  raw: string;
}

export function parseGradleSpecifier(name: string): GradleSpecifier {
  const at = name.lastIndexOf("@");
  const extension = at === -1 ? "jar" : name.slice(at + 1) || "jar";
  const coordinate = at === -1 ? name : name.slice(0, at);
  const parts = coordinate.split(":");
  if (parts.length < 3) throw new Error(`Coordenada Maven no válida: ${name}`);
  const [group, artifact, version, ...classifierParts] = parts;
  return {
    group,
    artifact,
    version,
    classifier: classifierParts.length ? classifierParts.join(":") : undefined,
    extension,
    raw: name,
  };
}

export function gradleToMavenPath(name: string, classifierOverride?: string): string {
  const spec = parseGradleSpecifier(name);
  const classifier = classifierOverride ?? spec.classifier;
  const fileName = `${spec.artifact}-${spec.version}${classifier ? `-${classifier}` : ""}.${spec.extension}`;
  return `${spec.group.replaceAll(".", "/")}/${spec.artifact}/${spec.version}/${fileName}`;
}

export function libraryArtifact(library: LibraryJson): { url: string; path: string; sha1?: string; size?: number } | null {
  const artifact = library.downloads?.artifact;
  if (artifact?.url) {
    return {
      url: artifact.url,
      path: artifact.path ?? gradleToMavenPath(library.name),
      sha1: artifact.sha1,
      size: artifact.size,
    };
  }

  // Prism meta / old Mojang libraries may only carry a coordinate and a base URL.
  try {
    const path = gradleToMavenPath(library.name);
    const base = library.url && library.url.trim() !== "" ? library.url : "https://libraries.minecraft.net/";
    return { url: `${base.endsWith("/") ? base : `${base}/`}${path}`, path };
  } catch {
    return null;
  }
}

export function libraryDedupKey(library: LibraryJson): string {
  try {
    const spec = parseGradleSpecifier(library.name);
    return `${spec.group}:${spec.artifact}:${spec.classifier ?? ""}`;
  } catch {
    return library.name;
  }
}

function dedupeLibraries(libraries: LibraryJson[]): LibraryJson[] {
  const byKey = new Map<string, LibraryJson>();
  const order: string[] = [];
  for (const library of libraries) {
    const key = libraryDedupKey(library);
    if (!byKey.has(key)) order.push(key);
    // Later definitions (child profile / later Prism patch) win, matching the
    // practical behaviour launchers need for loader overrides.
    byKey.set(key, library);
  }
  return order.map((key) => byKey.get(key)!).filter(Boolean);
}

function inferJavaMajor(version: VersionJson | ResolvedProfile): number {
  const fromJavaVersion = "javaVersion" in version ? version.javaVersion?.majorVersion : undefined;
  if (fromJavaVersion) return fromJavaVersion;
  const compatible = "compatibleJavaMajors" in version ? version.compatibleJavaMajors : undefined;
  if (compatible?.length) return compatible[0];
  return 8;
}

function toResolved(version: VersionJson, sourceChain: string[]): ResolvedProfile {
  return {
    id: version.id,
    clientVersionId: version.downloads?.client ? version.id : version.inheritsFrom ?? version.id,
    type: version.type ?? "release",
    mainClass: version.mainClass ?? "",
    appletClass: version.appletClass,
    minecraftArguments: version.minecraftArguments,
    arguments: version.arguments ? { game: version.arguments.game ?? [], jvm: version.arguments.jvm ?? [] } : undefined,
    libraries: [...(version.libraries ?? [])],
    clientDownload: version.downloads?.client,
    assetIndex: version.assetIndex ?? (version.assets ? { id: version.assets } : undefined),
    javaMajor: inferJavaMajor(version),
    tweakers: [],
    extraJvmArgs: [],
    traits: [],
    sourceChain,
    warnings: [],
  };
}

function mergeResolved(parent: ResolvedProfile, child: VersionJson): ResolvedProfile {
  const childResolved = toResolved(child, []);
  return {
    id: child.id,
    clientVersionId: child.downloads?.client ? child.id : parent.clientVersionId,
    type: child.type ?? parent.type,
    mainClass: child.mainClass ?? parent.mainClass,
    appletClass: child.appletClass ?? parent.appletClass,
    minecraftArguments: child.minecraftArguments ?? parent.minecraftArguments,
    arguments:
      parent.arguments || childResolved.arguments
        ? {
            game: [...(parent.arguments?.game ?? []), ...(childResolved.arguments?.game ?? [])],
            jvm: [...(parent.arguments?.jvm ?? []), ...(childResolved.arguments?.jvm ?? [])],
          }
        : undefined,
    libraries: dedupeLibraries([...parent.libraries, ...childResolved.libraries]),
    clientDownload: child.downloads?.client ?? parent.clientDownload,
    mainJarLibrary: parent.mainJarLibrary,
    assetIndex: childResolved.assetIndex ?? parent.assetIndex,
    javaMajor: Math.max(parent.javaMajor, childResolved.javaMajor),
    tweakers: [...parent.tweakers],
    extraJvmArgs: [...parent.extraJvmArgs],
    traits: [...parent.traits],
    sourceChain: [...parent.sourceChain],
    warnings: [...parent.warnings],
  };
}

export interface VersionJsonSource {
  getVersionJson(id: string): Promise<VersionJson>;
}

export async function resolveVersionProfile(id: string, source: VersionJsonSource, chain: string[] = []): Promise<ResolvedProfile> {
  if (chain.includes(id)) throw new Error(`Ciclo inheritsFrom detectado: ${[...chain, id].join(" -> ")}`);
  const version = await source.getVersionJson(id);
  const nextChain = [...chain, id];

  if (!version.inheritsFrom) {
    const resolved = toResolved(version, nextChain);
    resolved.libraries = dedupeLibraries(resolved.libraries);
    return resolved;
  }

  const parent = await resolveVersionProfile(version.inheritsFrom, source, nextChain);
  const merged = mergeResolved(parent, version);
  merged.sourceChain = [...parent.sourceChain, id];
  return merged;
}

export function applyPrismPatch(profile: ResolvedProfile, patch: PrismPatchJson): ResolvedProfile {
  const out: ResolvedProfile = {
    ...profile,
    libraries: [...profile.libraries],
    tweakers: [...profile.tweakers],
    extraJvmArgs: [...profile.extraJvmArgs],
    traits: [...profile.traits],
    warnings: [...profile.warnings],
    sourceChain: [...profile.sourceChain],
  };

  const uid = patch.uid ?? patch.fileId ?? patch.id ?? "patch";
  out.sourceChain.push(`patch:${uid}`);

  if (patch.mainClass) out.mainClass = patch.mainClass;
  if (patch.appletClass) out.appletClass = patch.appletClass;
  if (patch.minecraftArguments) out.minecraftArguments = patch.minecraftArguments;
  if (patch.arguments) {
    out.arguments = {
      game: [...(out.arguments?.game ?? []), ...(patch.arguments.game ?? [])],
      jvm: [...(out.arguments?.jvm ?? []), ...(patch.arguments.jvm ?? [])],
    };
  }
  if (patch.assetIndex) out.assetIndex = patch.assetIndex;
  if (patch.assets && !patch.assetIndex) out.assetIndex = { id: patch.assets };
  if (patch.downloads?.client) {
    out.clientDownload = patch.downloads.client;
    if (patch.id) out.clientVersionId = patch.id;
  }
  if (patch.mainJar) out.mainJarLibrary = patch.mainJar;
  out.javaMajor = Math.max(out.javaMajor, inferJavaMajor(patch));

  const addedLibraries = [...(patch.libraries ?? []), ...(patch["+libraries"] ?? []), ...(patch.mavenFiles ?? [])];
  if (addedLibraries.length) out.libraries = dedupeLibraries([...out.libraries, ...addedLibraries]);

  for (const tweaker of patch["+tweakers"] ?? []) if (!out.tweakers.includes(tweaker)) out.tweakers.push(tweaker);
  for (const arg of patch["+jvmArgs"] ?? []) out.extraJvmArgs.push(arg);
  for (const trait of patch["+traits"] ?? []) if (!out.traits.includes(trait)) out.traits.push(trait);

  if (patch.jarMods?.length) {
    out.warnings.push(`El patch ${uid} usa jarMods; WebPrism todavía no fusiona JAR mods dentro del cliente.`);
  }
  if (patch["+agents"]?.length) {
    out.warnings.push(`El patch ${uid} usa agentes Java (-javaagent); CheerpJ no recibe agentes en esta primera versión.`);
  }
  if (patch.mods?.length) {
    out.warnings.push(`El patch ${uid} declara mods como librerías; se ignoran hasta que exista un instalador específico.`);
  }

  return out;
}

export interface ClassifiedLibrary {
  library: LibraryJson;
  artifact?: { url: string; path: string; sha1?: string; size?: number };
  includeOnClasspath: boolean;
  isLwjgl2: boolean;
  isLwjgl3: boolean;
  hasNatives: boolean;
  skippedReason?: string;
}

export function classifyLibraries(profile: ResolvedProfile, context: RuleContext): ClassifiedLibrary[] {
  const out: ClassifiedLibrary[] = [];

  for (const library of profile.libraries) {
    let spec: GradleSpecifier | null = null;
    try {
      spec = parseGradleSpecifier(library.name);
    } catch {
      spec = null;
    }

    const classifierKeys = Object.keys(library.downloads?.classifiers ?? {});
    const hasNatives = Boolean(library.natives) || classifierKeys.some((key) => key.startsWith("natives"));
    const isLwjgl2 = spec?.group === "org.lwjgl.lwjgl";
    const isLwjgl3 = spec?.group === "org.lwjgl";
    const artifact = libraryArtifact(library) ?? undefined;
    const artifactLooksNative = Boolean(artifact && /(?:^|[-/])natives[-/]/.test(artifact.path));
    const active = evaluateRules(library.rules, context);

    let includeOnClasspath = active && Boolean(artifact) && !artifactLooksNative;
    let skippedReason: string | undefined;
    if (!active) {
      includeOnClasspath = false;
      skippedReason = "Reglas de Mojang no aplican a linux/web";
    } else if (!artifact) {
      includeOnClasspath = false;
      skippedReason = "Sin artefacto descargable";
    } else if (artifactLooksNative) {
      includeOnClasspath = false;
      skippedReason = "Artefacto nativo de escritorio";
    }

    out.push({ library, artifact, includeOnClasspath, isLwjgl2, isLwjgl3, hasNatives, skippedReason });
  }

  return out;
}

export type CompatibilityStatus = "known-good" | "experimental" | "blocked";

export interface Compatibility {
  status: CompatibilityStatus;
  javaRuntime: 8 | 11 | 17 | null;
  title: string;
  reasons: string[];
  blockers: string[];
  nativeLibraries: string[];
  hasLwjgl2: boolean;
  hasLwjgl3: boolean;
}

export function cheerpjRuntimeForJava(javaMajor: number): 8 | 11 | 17 | null {
  if (javaMajor <= 8) return 8;
  if (javaMajor <= 11) return 11;
  if (javaMajor <= 17) return 17;
  return null;
}

export function assessCompatibility(profile: ResolvedProfile, classified: ClassifiedLibrary[]): Compatibility {
  const reasons: string[] = [];
  const blockers: string[] = [];
  const nativeLibraries = [...new Set(classified.filter((entry) => entry.hasNatives).map((entry) => entry.library.name))];
  const hasLwjgl2 = classified.some((entry) => entry.isLwjgl2);
  const hasLwjgl3 = classified.some((entry) => entry.isLwjgl3);
  const javaRuntime = cheerpjRuntimeForJava(profile.javaMajor);

  if (!profile.mainClass) blockers.push("El perfil no declara mainClass.");
  if (!profile.clientDownload && !profile.mainJarLibrary) blockers.push("El perfil no declara la descarga del cliente (downloads.client/mainJar).");
  if (!javaRuntime) blockers.push(`Requiere Java ${profile.javaMajor}; CheerpJ actualmente ofrece runtimes 8, 11 y 17.`);
  if (hasLwjgl3) {
    blockers.push("Usa LWJGL 3 + GLFW/OpenAL nativos. Todavía no existe una capa wasm pública equivalente en este launcher.");
  }
  if (profile.appletClass && !profile.minecraftArguments && !profile.arguments) {
    blockers.push("Es un perfil applet muy antiguo; el adaptador applet aún no está implementado.");
  }

  if (profile.clientVersionId === "1.2.5" && hasLwjgl2) {
    reasons.push("1.2.5 es el objetivo demostrado por Browsercraft con CheerpJ + LWJGL2 wasm.");
  } else if (hasLwjgl2) {
    reasons.push("Usa LWJGL 2: puede intentar arrancar con la capa wasm LWJGL2/gl4es, pero cada versión puede necesitar parches.");
  } else if (!hasLwjgl3) {
    reasons.push("No se detectó LWJGL 3; se intentará como aplicación Java genérica en CheerpJ.");
  }

  if (nativeLibraries.length) {
    reasons.push(`Hay ${nativeLibraries.length} librería(s) con nativos de escritorio; solo LWJGL2 se sustituye por wasm.`);
  }
  reasons.push(...profile.warnings);

  const status: CompatibilityStatus = blockers.length ? "blocked" : profile.clientVersionId === "1.2.5" ? "known-good" : "experimental";
  const title = status === "known-good" ? "Ruta JVM demostrada" : status === "experimental" ? "Ruta JVM experimental" : "Bloqueado en navegador por ahora";

  return { status, javaRuntime, title, reasons, blockers, nativeLibraries, hasLwjgl2, hasLwjgl3 };
}

export interface AssetIndexJson {
  objects: Record<string, { hash?: string; sha1?: string; size: number }>;
  virtual?: boolean;
  map_to_resources?: boolean;
}

export function assetObjectRelativePath(hash: string): string {
  return `${hash.slice(0, 2)}/${hash}`;
}

export function legacyAssetIndexUrl(assetIndex: AssetIndexInfo): string | undefined {
  if (assetIndex.url) return assetIndex.url;
  if (assetIndex.id === "legacy") {
    return "https://piston-meta.mojang.com/mc/assets/legacy/c0fd82e8ce9fbc93119e40d96d5a4e62cfa3f729/legacy.json";
  }
  return undefined;
}
