import { describe, expect, it } from "vitest";
import {
  createInstanceCfg,
  createPackProfile,
  inferMinecraftVersionFromProfileId,
  packProfileMinecraftVersion,
  parseInstanceCfg,
  parsePackProfile,
  removePackComponents,
  serializeInstanceCfg,
  setPackProfileMinecraftVersion,
  slugifyInstanceId,
  upsertPackComponents,
} from "./prism";

describe("Prism formats", () => {
  it("round-trips flat instance.cfg files", () => {
    const text = createInstanceCfg("Mundo de prueba");
    const settings = parseInstanceCfg(text);
    expect(settings.InstanceType).toBe("OneSix");
    expect(settings.name).toBe("Mundo de prueba");
    expect(serializeInstanceCfg(settings)).toContain("name=Mundo de prueba");
  });

  it("accepts a [General] section and quoted commands", () => {
    const settings = parseInstanceCfg('[General]\nInstanceType=OneSix\nname=Hola\nPreLaunchCommand="\\"java\\" -jar x.jar"\n[Other]\nname=No\n');
    expect(settings.name).toBe("Hola");
    expect(settings.PreLaunchCommand).toBe('"java" -jar x.jar');
  });

  it("creates and updates mmc-pack.json net.minecraft", () => {
    const profile = createPackProfile("1.12.2");
    expect(packProfileMinecraftVersion(profile)).toBe("1.12.2");
    const updated = setPackProfileMinecraftVersion(profile, "1.8.9");
    expect(packProfileMinecraftVersion(updated)).toBe("1.8.9");
    expect(parsePackProfile(JSON.stringify(updated)).formatVersion).toBe(1);
  });

  it("installs loader components while removing the previous loader", () => {
    const profile = upsertPackComponents(createPackProfile("1.20.1"), [
      { uid: "net.minecraftforge", version: "47.2.0" },
    ]);
    const replaced = upsertPackComponents(
      profile,
      [
        { uid: "net.fabricmc.intermediary", version: "1.20.1", dependencyOnly: true },
        { uid: "net.fabricmc.fabric-loader", version: "0.16.0" },
      ],
      ["net.minecraftforge"],
    );
    expect(replaced.components.map((component) => component.uid)).toEqual([
      "net.minecraft",
      "net.fabricmc.intermediary",
      "net.fabricmc.fabric-loader",
    ]);
    const removed = removePackComponents(replaced, ["net.fabricmc.fabric-loader", "net.fabricmc.intermediary"]);
    expect(removed.components.map((component) => component.uid)).toEqual(["net.minecraft"]);
  });

  it("infers the game version from imported loader profile IDs", () => {
    expect(inferMinecraftVersionFromProfileId("1.12.2-forge-14.23.5.2860")).toBe("1.12.2");
    expect(inferMinecraftVersionFromProfileId("fabric-loader-0.16.10-1.20.1")).toBe("1.20.1");
    expect(inferMinecraftVersionFromProfileId("24w14a")).toBe("24w14a");
  });

  it("rejects invalid pack profiles", () => {
    expect(() => parsePackProfile('{"formatVersion":99,"components":[]}')).toThrow();
    expect(() => parsePackProfile('{"formatVersion":1,"components":[{}]}')).toThrow();
  });

  it("slugifies instance IDs safely", () => {
    expect(slugifyInstanceId("Mi instancia ñoña!")).toBe("Mi-instancia-nona");
    expect(slugifyInstanceId("...")).toBe("instance");
    expect(slugifyInstanceId("1.12.2 Forge")).toBe("1.12.2-Forge");
  });
});
