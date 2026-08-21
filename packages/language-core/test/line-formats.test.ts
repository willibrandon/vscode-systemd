import { describe, expect, it } from "vitest";
import { lineSettingsFor, recordFormatFor } from "../src/index.js";
import type { DocumentKind } from "../src/index.js";

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

  it.each([
    ["systemd-tmpfiles:tmpfiles", "tmpfiles.d entry"],
    ["systemd-sysusers:sysusers", "sysusers.d entry"],
    ["systemd-udev-rules:rules", "udev rule"],
    ["systemd-modules-load:modules-load", "modules-load.d entry"],
    ["systemd-binfmt:binfmt", "binfmt_misc rule"],
    ["systemd-preset:preset", "systemd preset directive"],
    ["systemd-table:fstab", "fstab entry"],
    ["systemd-table:crypttab", "crypttab entry"],
    ["systemd-table:veritytab", "veritytab entry"],
    ["systemd-table:integritytab", "integritytab entry"],
    ["systemd-table:clonetab", "clonetab entry"],
    ["systemd-dns-trust-anchor:positive", "positive DNSSEC trust anchor"],
    ["systemd-dns-trust-anchor:negative", "negative DNSSEC trust anchor"],
    ["systemd-boot:loader", "systemd-boot loader option"],
    ["systemd-boot:entry", "Boot Loader Specification Type #1 field"],
    ["systemd-boot:kernel-command-line", "kernel command line"],
    ["systemd-environment:hostname", "static hostname"],
  ] satisfies readonly (readonly [DocumentKind, string])[])(
    "selects the %s record grammar",
    (kind, expectedName) => {
      const format = recordFormatFor(kind);
      expect(format?.name).toBe(expectedName);
      expect(format?.fields.length).toBeGreaterThan(0);
      expect(format?.documentation).toMatch(/^https:\/\//u);
    },
  );

  it("does not invent a record grammar for section-oriented documents", () => {
    expect(recordFormatFor("systemd-unit:service")).toBeUndefined();
  });

  it.each([
    ["systemd-boot:kernel-install", "MACHINE_ID"],
    ["systemd-environment:os-release", "NAME"],
    ["systemd-environment:machine-info", "PRETTY_HOSTNAME"],
    ["systemd-environment:locale", "LANG"],
    ["systemd-environment:vconsole", "KEYMAP"],
  ] satisfies readonly (readonly [DocumentKind, string])[])(
    "selects the %s assignment vocabulary",
    (kind, expectedFirstSetting) => {
      const settings = lineSettingsFor(kind);
      expect(settings[0]?.name).toBe(expectedFirstSetting);
      expect(settings.every(({ documentation }) => documentation.startsWith("https://"))).toBe(
        true,
      );
    },
  );

  it("does not invent assignments for a positional record format", () => {
    expect(lineSettingsFor("systemd-table:fstab")).toEqual([]);
  });
});
