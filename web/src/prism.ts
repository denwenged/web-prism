import type { InstanceSettings, PrismPackProfile } from "./types";

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

export function describeComponent(uid: string): string {
  if (uid === "net.minecraft") return "Minecraft";
  if (uid === "org.lwjgl" || uid === "org.lwjgl3") return "LWJGL";
  return LOADER_COMPONENTS.get(uid) ?? uid;
}

export function isLoaderComponent(uid: string): boolean {
  return LOADER_COMPONENTS.has(uid);
}
