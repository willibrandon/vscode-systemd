import { describe, expect, it } from "vitest";
import { lineSettingsFor, recordFormatFor } from "../src/index.js";

describe("line-oriented language metadata", () => {
  it("describes every position in the seven-column tmpfiles grammar", () => {
    const format = recordFormatFor("systemd-tmpfiles:tmpfiles");
    expect(format?.fields.map(({ name }) => name)).toEqual([
      "Type",
      "Path",
      "Mode",
      "User",
      "Group",
      "Age",
      "Argument",
    ]);
    expect(format?.fields[0]?.choices).toEqual(expect.arrayContaining(["f+", "L?", "K"]));
  });

  it("keeps table layouts and DNSSEC formats distinct", () => {
    expect(recordFormatFor("systemd-table:crypttab")?.fields).toHaveLength(4);
    expect(recordFormatFor("systemd-table:veritytab")?.fields).toHaveLength(5);
    expect(
      recordFormatFor("systemd-table:clonetab")
        ?.fields.slice(0, 4)
        .every(({ required }) => required),
    ).toBe(true);
    expect(recordFormatFor("systemd-dns-trust-anchor:positive")?.fields).toHaveLength(7);
    expect(recordFormatFor("systemd-dns-trust-anchor:negative")?.fields).toHaveLength(1);
  });

  it("exposes source-backed boot and environment settings", () => {
    expect(recordFormatFor("systemd-boot:loader")?.keywords.map(({ name }) => name)).toEqual(
      expect.arrayContaining(["timeout", "secure-boot-enroll", "console-mode"]),
    );
    expect(lineSettingsFor("systemd-boot:kernel-install").map(({ name }) => name)).toEqual(
      expect.arrayContaining(["MACHINE_ID", "BOOT_ROOT", "layout", "uki_generator"]),
    );
    expect(lineSettingsFor("systemd-environment:os-release").map(({ name }) => name)).toEqual(
      expect.arrayContaining(["ID", "VERSION_ID", "SYSEXT_SCOPE", "RELEASE_TYPE"]),
    );
  });
});
