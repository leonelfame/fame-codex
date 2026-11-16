import { describe, expect, test } from "bun:test";
import { isSupportedBunVersion } from "../scripts/bun-version";

describe("minimum supported Bun version", () => {
  test.each([
    ["1.4.0", true],
    ["1.4.4", true],
    ["1.5.0", true],
    ["2.0.0", true],
    ["1.3.99", false],
    ["1.4.0-canary.1", false],
    ["garbage", false],
  ])("Bun %s supported=%s", (version, expected) => {
    expect(isSupportedBunVersion(version, "1.4.0")).toBe(expected);
  });
});
