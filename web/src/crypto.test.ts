import { describe, expect, it } from "vitest";
import { isValidOfflineUsername, md5Hex, offlineUuid } from "./crypto";

describe("crypto helpers", () => {
  it("computes MD5 test vectors", () => {
    expect(md5Hex("")).toBe("d41d8cd98f00b204e9800998ecf8427e");
    expect(md5Hex("abc")).toBe("900150983cd24fb0d6963f7d28e17f72");
    expect(md5Hex("The quick brown fox jumps over the lazy dog")).toBe("9e107d9d372bb6826bd81d3542a419d6");
  });

  it("derives stable version-3 offline UUIDs", () => {
    const uuid = offlineUuid("Steve");
    expect(uuid).toHaveLength(32);
    expect(uuid[12]).toBe("3");
    expect(["8", "9", "a", "b"]).toContain(uuid[16]);
    expect(offlineUuid("Steve", true)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(offlineUuid("Steve")).toBe(offlineUuid("Steve"));
    expect(offlineUuid("Alex")).not.toBe(offlineUuid("Steve"));
  });

  it("validates offline usernames like Java Edition names", () => {
    expect(isValidOfflineUsername("Steve_01")).toBe(true);
    expect(isValidOfflineUsername("ab")).toBe(false);
    expect(isValidOfflineUsername("con espacios")).toBe(false);
    expect(isValidOfflineUsername("demasiadolargo123")).toBe(false);
  });
});
