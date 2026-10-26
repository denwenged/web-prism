import type { InstanceSettings, PrismComponent, PrismPackProfile } from "./types";

export function slugifyInstanceId(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^\.+$/, "instance");
  return slug || "instance";
}

function decodeIniValue(raw: string): string {
  let value = raw.trim();
  // Prism's INI writer (Qt QSettings compatible) quotes values that need it.
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1);
  }
  return value
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

function encodeIniValue(value: string): string {
  const needsQuotes = value === "" || /^\s|\s$|[=;\n\t"]/.test(value);
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\t/g, "\\t");
  return needsQuotes ? `"${escaped}"` : escaped;
}

/**
 * Parses the flat INI dialect Prism writes in instance.cfg. A leading
 * [General] section (as produced by some Qt tools) is also accepted.
 */
export function parseInstanceCfg(text: string): InstanceSettings {
  const settings: InstanceSettings = {};
  let inGeneral = true;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      inGeneral = line.slice(1, -1).trim().toLowerCase() === "general";
      continue;
    }
    if (!inGeneral) continue;
    const equals = line.indexOf("=");
    if (equals <= 0) continue;
    const key = line.slice(0, equals).trim();
    settings[key] = decodeIniValue(line.slice(equals + 1));
  }

  return settings;
}

export function serializeInstanceCfg(settings: InstanceSettings): string {
  const preferredOrder = ["InstanceType", "ConfigVersion", "iconKey", "name", "notes", "lastLaunchTime", "totalTimePlayed", "lastTimePlayed"];
  const keys = Object.keys(settings).sort((a, b) => {
    const ai = preferredOrder.indexOf(a);
    const bi = preferredOrder.indexOf(b);
    if (ai !== -1 || bi !== -1) return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    return a.localeCompare(b);
  });
  return `${keys.map((key) => `${key}=${encodeIniValue(settings[key] ?? "")}`).join("\n")}\n`;
}

export function createInstanceCfg(name: string): string {
  return serializeInstanceCfg({
    InstanceType: "OneSix",
    ConfigVersion: "1.3",
    iconKey: "default",
    name,
    notes: "Creada con WebPrism (launcher web experimental)",
    lastLaunchTime: "0",
    totalTimePlayed: "0",
    lastTimePlayed: "0",
  });
}

export function parsePackProfile(text: string): PrismPackProfile {
  const parsed = JSON.parse(text) as PrismPackProfile;
  if (parsed.formatVersion !== 1 || !Array.isArray(parsed.components)) {
    throw new Error("mmc-pack.json no tiene formatVersion=1 o le falta la lista de componentes.");
  }
  for (const component of parsed.components) {
    if (!component || typeof component.uid !== "string" || component.uid === "") {
      throw new Error("mmc-pack.json contiene un componente sin uid.");
    }
  }
  return parsed;
}

export function createPackProfile(minecraftVersion: string): PrismPackProfile {
  return {
    formatVersion: 1,
    components: [
      {
        uid: "net.minecraft",
        version: minecraftVersion,
        important: true,
        cachedName: "Minecraft",
        cachedVersion: minecraftVersion,
      },
    ],
  };
}

export function packProfileMinecraftVersion(profile: PrismPackProfile | null | undefined): string {
  const component = profile?.components.find((entry) => entry.uid === "net.minecraft");
  return component?.version || component?.cachedVersion || "";
}

export function setPackProfileMinecraftVersion(profile: PrismPackProfile, minecraftVersion: string): PrismPackProfile {
  let found = false;
  const components = profile.components.map((component) => {
    if (component.uid !== "net.minecraft") return component;
    found = true;
    return { ...component, version: minecraftVersion, cachedVersion: minecraftVersion, important: true };
  });
  if (!found) {
    components.unshift({
      uid: "net.minecraft",
      version: minecraftVersion,
      important: true,
      cachedName: "Minecraft",
      cachedVersion: minecraftVersion,
    });
  }
  return { formatVersion: 1, components };
}

const LOADER_COMPONENTS = new Map<string, string>([
  ["net.fabricmc.fabric-loader", "Fabric"],
  ["org.quiltmc.quilt-loader", "Quilt"],
  ["net.minecraftforge", "Forge"],
  ["net.neoforged", "NeoForge"],
  ["com.mumfrey.liteloader", "LiteLoader"],
]);

export const PRIMARY_LOADER_UIDS = [...LOADER_COMPONENTS.keys()];
export const INTERMEDIARY_UID = "net.fabricmc.intermediary";

const LOADER_SLUGS = new Map<string, string>([
  ["net.fabricmc.fabric-loader", "fabric"],
  ["org.quiltmc.quilt-loader", "quilt"],
  ["net.minecraftforge", "forge"],
  ["net.neoforged", "neoforge"],
  ["com.mumfrey.liteloader", "liteloader"],
]);

export function describeComponent(uid: string): string {
  if (uid === "net.minecraft") return "Minecraft";
  if (uid === "org.lwjgl") return "LWJGL 2";
  if (uid === "org.lwjgl3") return "LWJGL 3";
  if (uid === INTERMEDIARY_UID) return "Intermediary";
  return LOADER_COMPONENTS.get(uid) ?? uid;
}

export function isLoaderComponent(uid: string): boolean {
  return LOADER_COMPONENTS.has(uid);
}

export function loaderSlugForComponent(uid: string): string | undefined {
  return LOADER_SLUGS.get(uid);
}

export function modrinthLoaderSlugsForUid(uid: string): string[] {
  const slug = loaderSlugForComponent(uid);
  if (!slug) return [];
  // Quilt intentionally loads most Fabric mods, which Modrinth models as two
  // separate categories/loaders.
  return slug === "quilt" ? ["quilt", "fabric"] : [slug];
}

export function primaryLoaderComponent(components: PrismComponent[]): PrismComponent | undefined {
  return components.find((component) => !component.disabled && isLoaderComponent(component.uid));
}

export function inferMinecraftVersionFromProfileId(profileId: string): string | undefined {
  const snapshot = /^(\d{2}w\d{2}[a-z])(?:[-_].+)?$/i.exec(profileId);
  if (snapshot) return snapshot[1];
  const matches = [...profileId.matchAll(/(?:^|[-_])(1\.\d+(?:\.\d+)?)(?=$|[-_])/g)];
  if (!matches.length) return undefined;
  // Profiles are usually either "1.12.2-forge-..." (version first) or
  // "fabric-loader-0.16.10-1.20.1" (version last). Prefer a leading version,
  // otherwise use the last plausible Minecraft-looking segment.
  return profileId.startsWith(matches[0][1]) ? matches[0][1] : matches[matches.length - 1][1];
}

export function inferLoaderSlugFromProfileId(profileId: string): string | undefined {
  const value = profileId.toLowerCase();
  if (value.includes("neoforge") || value.includes("neoforged")) return "neoforge";
  if (value.includes("fabric")) return "fabric";
  if (value.includes("quilt")) return "quilt";
  if (value.includes("forge")) return "forge";
  if (value.includes("liteloader")) return "liteloader";
  return undefined;
}

export function removePackComponents(profile: PrismPackProfile, uids: Iterable<string>): PrismPackProfile {
  const remove = new Set(uids);
  return {
    formatVersion: 1,
    components: profile.components.filter((component) => !remove.has(component.uid)),
  };
}

export function upsertPackComponents(
  profile: PrismPackProfile,
  additions: PrismComponent[],
  removeUids: Iterable<string> = [],
): PrismPackProfile {
  const remove = new Set(removeUids);
  for (const addition of additions) remove.add(addition.uid);
  const components = profile.components.filter((component) => !remove.has(component.uid));
  for (const addition of additions) {
    components.push({
      ...addition,
      version: addition.version ?? addition.cachedVersion,
      cachedVersion: addition.cachedVersion ?? addition.version,
      cachedName: addition.cachedName ?? describeComponent(addition.uid),
      disabled: false,
    });
  }
  return { formatVersion: 1, components };
}
