import { describe, expect, it } from "vitest";
import {
  createInstanceCfg,
  createPackProfile,
  packProfileMinecraftVersion,
  parseInstanceCfg,
  parsePackProfile,
  serializeInstanceCfg,
  setPackProfileMinecraftVersion,
  slugifyInstanceId,
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
