import { describe, expect, it } from "vitest";
import { parseInstalledVersion } from "../src/target-versions.js";

describe("installed target version parsing", () => {
  it.each([
    ["systemd", "systemd 261 (261.1-2)\n+PAM", "261"],
    ["podman", "podman version 5.8.6", "5.8.6"],
    ["podman", "Podman v6.1.0-dev", "6.1.0"],
    ["mkosi", "mkosi 26", "26"],
  ] as const)("parses %s output", (ecosystem, output, expected) => {
    expect(parseInstalledVersion(ecosystem, output)).toBe(expected);
  });

  it("rejects unrelated output", () => {
    expect(parseInstalledVersion("systemd", "unknown tool 261")).toBeUndefined();
  });
});
