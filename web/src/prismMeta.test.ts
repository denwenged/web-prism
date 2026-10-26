import { describe, expect, it } from "vitest";
import {
  chooseMetaEntry,
  filterMetaVersionsForMinecraft,
  loaderSupportsMinecraft,
  type PrismMetaVersionEntry,
} from "./prismMeta";

const entries: PrismMetaVersionEntry[] = [
  {
    version: "2.0",
    releaseTime: "2025-01-02T00:00:00Z",
    type: "release",
    requires: [{ uid: "net.minecraft", equals: "1.21.1" }],
  },
  {
    version: "1.0",
    releaseTime: "2024-01-01T00:00:00Z",
    type: "release",
    recommended: true,
    requires: [{ uid: "net.minecraft", equals: "1.20.1" }],
  },
  {
    version: "3.0-beta",
    releaseTime: "2025-02-01T00:00:00Z",
    type: "beta",
  },
];

describe("Prism Meta filtering", () => {
  it("filters exact Minecraft requirements and keeps unconstrained versions", () => {
    expect(filterMetaVersionsForMinecraft("net.minecraftforge", entries, "1.20.1").map((entry) => entry.version)).toEqual([
      "3.0-beta",
      "1.0",
    ]);
    expect(filterMetaVersionsForMinecraft("net.minecraftforge", entries, "1.21.1").map((entry) => entry.version)).toEqual([
      "3.0-beta",
      "2.0",
    ]);
  });

  it("prefers exact, suggested and recommended dependency versions", () => {
    expect(chooseMetaEntry("net.minecraftforge", entries, "1.21.1", undefined, "2.0")?.version).toBe("2.0");
    expect(chooseMetaEntry("net.minecraftforge", entries, "1.20.1", { uid: "net.minecraftforge", suggests: "1.0" })?.version).toBe("1.0");
    expect(chooseMetaEntry("net.minecraftforge", entries, "1.20.1")?.version).toBe("1.0");
  });

  it("does not offer Fabric/Quilt for pre-1.14 Minecraft", () => {
    expect(loaderSupportsMinecraft("net.fabricmc.fabric-loader", "1.12.2")).toBe(false);
    expect(loaderSupportsMinecraft("org.quiltmc.quilt-loader", "1.20.1")).toBe(true);
    expect(filterMetaVersionsForMinecraft("net.fabricmc.fabric-loader", entries, "1.12.2")).toEqual([]);
  });
});
