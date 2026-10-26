import { describe, expect, it } from "vitest";
import {
  buildModrinthFacets,
  pickPreferredModrinthVersion,
  primaryModrinthFile,
  resourceKindForModrinthProject,
  resourceKindForModrinthVersion,
  type ModrinthVersion,
} from "./modrinth";
import { isResourceFileName, stripDisabledSuffix } from "./resources";

function version(partial: Partial<ModrinthVersion>): ModrinthVersion {
  return {
    id: "v",
    project_id: "p",
    name: "Test",
    version_number: "1",
    game_versions: ["1.20.1"],
    loaders: ["fabric"],
    version_type: "release",
    date_published: "2024-01-01T00:00:00Z",
    files: [{ hashes: {}, url: "https://example.test/mod.jar", filename: "mod.jar", primary: true, size: 3 }],
    dependencies: [],
    ...partial,
  };
}

describe("Modrinth helpers", () => {
  it("builds loader/version facets like Prism", () => {
    expect(buildModrinthFacets("mods", { minecraftVersion: "1.20.1", loaderSlugs: ["fabric"] })).toEqual([
      ["project_type:mod"],
      ["categories:fabric"],
      ["versions:1.20.1"],
    ]);
    expect(buildModrinthFacets("datapacks", { minecraftVersion: "1.20.1", loaderSlugs: [] })).toContainEqual([
      "all_project_types:datapack",
    ]);
  });

  it("prefers stable installable files and the primary file", () => {
    const beta = version({ id: "beta", version_type: "beta", date_published: "2025-01-01T00:00:00Z" });
    const release = version({ id: "release", date_published: "2024-01-01T00:00:00Z" });
    const wrongFile = version({
      id: "wrong",
      files: [{ hashes: {}, url: "https://example.test/readme.txt", filename: "readme.txt", primary: true, size: 1 }],
    });
    expect(pickPreferredModrinthVersion("mods", [beta, wrongFile, release])?.id).toBe("release");
    expect(primaryModrinthFile(release)?.filename).toBe("mod.jar");
  });

  it("routes dependency projects and datapack files to the right folder", () => {
    expect(resourceKindForModrinthProject({ id: "p", title: "Pack", project_type: "resourcepack" }, "mods")).toBe("resourcepacks");
    expect(resourceKindForModrinthProject({ id: "p", title: "Dual", project_type: "mod" }, "datapacks")).toBe("datapacks");
    const dataPackVersion = version({
      loaders: ["datapack"],
      files: [{ hashes: {}, url: "https://example.test/pack.zip", filename: "pack.zip", primary: true, size: 3 }],
    });
    expect(resourceKindForModrinthVersion(dataPackVersion, "mods", ["fabric"])).toBe("datapacks");
  });

  it("recognizes disabled resource files", () => {
    expect(stripDisabledSuffix("jei.jar.disabled")).toBe("jei.jar");
    expect(isResourceFileName("mods", "jei.jar.disabled")).toBe(true);
    expect(isResourceFileName("shaderpacks", "shader.jar")).toBe(false);
  });
});
