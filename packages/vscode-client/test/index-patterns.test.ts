import { minimatch } from "minimatch";
import { describe, expect, it } from "vitest";
import { configurationWorkspaceGlobs } from "../src/index-patterns.js";

const matches = (path: string, suffixes: readonly string[] = []): boolean =>
  configurationWorkspaceGlobs(suffixes).some((pattern) => minimatch(path, pattern, { dot: true }));

describe("workspace index coverage", () => {
  it.each([
    "units/demo.service",
    "units/demo.service.d/override.conf",
    "network/10-lan.network.d/50-routes.conf",
    "etc/systemd/journald@audit.conf",
    "etc/systemd/journald@audit.conf.d/override.conf",
    "etc/tmpfiles.d/app.conf",
    "etc/sysusers.d/app.conf",
    "etc/systemd/repart.d/10-root.conf",
    "etc/systemd/sysupdate.d/transfer.conf",
    "etc/systemd/portable/profile/default/app.conf",
    "boot/loader/entries/linux.conf",
    "etc/kernel/install.conf.d/local.conf",
    "etc/hostname",
    "mkosi.conf",
    "mkosi.conf.d/10-base.conf",
    "mkosi.presets/server.conf",
    "mkosi.presets/server/mkosi.conf.d/20-packages.conf",
    "mkosi.profiles/debug",
    "mkosi.profiles/release/mkosi.conf.d/20-packages.conf",
    "mkosi.images/initrd.conf",
    "mkosi.images/base/mkosi.conf",
    "mkosi.local/mkosi.conf.d/99-local.conf",
    "mkosi.tools.conf/mkosi.conf",
    "mkosi.initrd.conf/mkosi.conf",
    "mkosi.uki-profiles/secure.conf",
    "mkosi.repart/10-root.conf",
  ])("indexes %s", (path) => {
    expect(matches(path)).toBe(true);
  });

  it("indexes configured working-copy suffixes across base files and drop-ins", () => {
    expect(matches("units/demo.service.j2", [".j2"])).toBe(true);
    expect(matches("units/demo.service.d/override.conf.j2", [".j2"])).toBe(true);
    expect(matches("etc/systemd/journald.conf.d/local.conf.j2", [".j2"])).toBe(true);
    expect(matches("etc/tmpfiles.d/app.conf.j2", [".j2"])).toBe(true);
    expect(matches("mkosi.images/base/mkosi.conf.d/packages.conf.j2", [".j2"])).toBe(true);
  });

  it("does not mistake mkosi content trees for configuration", () => {
    expect(matches("mkosi.extra/usr/lib/systemd/system/demo.service")).toBe(true);
    expect(matches("mkosi.extra/etc/arbitrary.conf")).toBe(false);
    expect(matches("mkosi.images/not-a-regular-subimage")).toBe(false);
  });
});
