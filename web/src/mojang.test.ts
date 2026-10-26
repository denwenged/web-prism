import { describe, expect, it } from "vitest";
import {
  applyPrismPatch,
  assessCompatibility,
  classifyLibraries,
  evaluateRules,
  expandArguments,
  gradleToMavenPath,
  libraryArtifact,
  parseGradleSpecifier,
  resolveVersionProfile,
  tokenizeLegacyArguments,
  webRuleContext,
  type VersionJson,
} from "./mojang";

describe("Mojang metadata", () => {
  it("parses Gradle/Maven coordinates", () => {
    expect(parseGradleSpecifier("org.lwjgl:lwjgl:3.3.3")).toMatchObject({ group: "org.lwjgl", artifact: "lwjgl", version: "3.3.3" });
    expect(gradleToMavenPath("com.example:demo:1.0:natives-linux")).toBe("com/example/demo/1.0/demo-1.0-natives-linux.jar");
    expect(libraryArtifact({ name: "com.example:demo:1.0", url: "https://maven.example.test" })?.url).toBe(
      "https://maven.example.test/com/example/demo/1.0/demo-1.0.jar",
    );
  });

  it("evaluates Mojang allow/disallow rules with last-match-wins", () => {
    const context = webRuleContext(true);
    expect(evaluateRules(undefined, context)).toBe(true);
    expect(evaluateRules([{ action: "allow" }, { action: "disallow", os: { name: "linux" } }], context)).toBe(false);
    expect(evaluateRules([{ action: "allow", os: { name: "windows" } }], context)).toBe(false);
    expect(evaluateRules([{ action: "allow", features: { has_custom_resolution: true } }], context)).toBe(true);
  });

  it("expands structured arguments and tokenizes legacy arguments", () => {
    const context = webRuleContext(true);
    expect(
      expandArguments(
        ["--username", { rules: [{ action: "allow", features: { has_custom_resolution: true } }], value: ["--width", "854"] }],
        context,
      ),
    ).toEqual(["--username", "--width", "854"]);
    expect(tokenizeLegacyArguments('--demo "two words" plain')).toEqual(["--demo", "two words", "plain"]);
  });

  it("resolves inheritsFrom by merging libraries and arguments", async () => {
    const versions: Record<string, VersionJson> = {
      "1.12.2": {
        id: "1.12.2",
        type: "release",
        mainClass: "net.minecraft.client.main.Main",
        minecraftArguments: "--username ${auth_player_name}",
        downloads: { client: { url: "https://example.test/client.jar", sha1: "abc", size: 3 } },
        assetIndex: { id: "1.12", url: "https://example.test/index.json" },
        libraries: [{ name: "org.lwjgl.lwjgl:lwjgl:2.9.4-nightly-20150209" }],
      },
      custom: {
        id: "custom",
        inheritsFrom: "1.12.2",
        type: "release",
        mainClass: "net.minecraft.launchwrapper.Launch",
        libraries: [{ name: "net.example:loader:1.0" }],
      },
    };

    const profile = await resolveVersionProfile("custom", { getVersionJson: async (id) => versions[id] });
    expect(profile.clientVersionId).toBe("1.12.2");
    expect(profile.mainClass).toContain("launchwrapper");
    expect(profile.libraries.map((library) => library.name)).toEqual([
      "org.lwjgl.lwjgl:lwjgl:2.9.4-nightly-20150209",
      "net.example:loader:1.0",
    ]);
  });

  it("classifies LWJGL2 as experimental and LWJGL3 as blocked", async () => {
    const legacy = await resolveVersionProfile("legacy", {
      getVersionJson: async () => ({
        id: "legacy",
        mainClass: "net.minecraft.client.main.Main",
        downloads: { client: { url: "https://example.test/client.jar" } },
        libraries: [{ name: "org.lwjgl.lwjgl:lwjgl:2.9.3" }],
      }),
    });
    const legacyClassified = classifyLibraries(legacy, webRuleContext());
    expect(assessCompatibility(legacy, legacyClassified).status).toBe("experimental");

    const modern = await resolveVersionProfile("modern", {
      getVersionJson: async () => ({
        id: "modern",
        mainClass: "net.minecraft.client.main.Main",
        downloads: { client: { url: "https://example.test/client.jar" } },
        javaVersion: { majorVersion: 21 },
        libraries: [{ name: "org.lwjgl:lwjgl:3.3.3" }],
      }),
    });
    const modernCompatibility = assessCompatibility(modern, classifyLibraries(modern, webRuleContext()));
    expect(modernCompatibility.status).toBe("blocked");
    expect(modernCompatibility.blockers.join(" ")).toContain("LWJGL 3");
    expect(modernCompatibility.blockers.join(" ")).toContain("Java 21");
  });

  it("applies Prism patch libraries, tweakers and JVM args", async () => {
    const base = await resolveVersionProfile("base", {
      getVersionJson: async () => ({
        id: "base",
        mainClass: "net.minecraft.client.main.Main",
        downloads: { client: { url: "https://example.test/client.jar" } },
        libraries: [],
      }),
    });
    const patched = applyPrismPatch(base, {
      id: "patch",
      uid: "net.example.loader",
      mainClass: "example.Loader",
      "+libraries": [{ name: "net.example:loader:2.0" }],
      "+tweakers": ["example.Tweaker"],
      "+jvmArgs": ["-Dexample=true"],
    });
    expect(patched.mainClass).toBe("example.Loader");
    expect(patched.libraries.map((library) => library.name)).toContain("net.example:loader:2.0");
    expect(patched.tweakers).toEqual(["example.Tweaker"]);
    expect(patched.extraJvmArgs).toEqual(["-Dexample=true"]);
  });
});
