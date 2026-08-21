import { describe, expect, it } from "vitest";
import { analyze, parse } from "../src/index.js";
import type { DialectId } from "../src/index.js";

const codes = (source: string, dialect: DialectId, uri = "file:///workspace/input.conf") =>
  analyze(parse(source, dialect, uri)).map(({ code }) => code);

describe("INI semantic analysis", () => {
  it("reports structural, unknown, version, and deprecated settings", () => {
    expect(codes("Description=outside\n", "systemd-unit", "file:///demo.service")).toEqual(
      expect.arrayContaining(["setting-outside-section", "missing-required-section"]),
    );
    expect(codes("[Unknown]\nBogus=yes\n", "systemd-config")).toEqual(
      expect.arrayContaining(["unknown-section", "unknown-setting"]),
    );
    expect(
      analyze(parse("[Component]\nConditionArchitecture=x86-64\n", "systemd-config"), {
        targetVersion: "v261",
      }).map(({ code }) => code),
    ).toContain("setting-unavailable");
    expect(codes("[Build]\nPackageManagerTrees=/tmp/tree\n", "mkosi")).toContain(
      "deprecated-setting",
    );
  });

  it("accepts dynamic names, resets, templates, and supported target aliases", () => {
    for (const value of ["", "{{ enabled }}", "@ENABLED@", "{% if enabled %}yes{% endif %}"]) {
      expect(codes("[Coredump]\nCompress=" + value + "\n", "systemd-config")).not.toContain(
        "invalid-value",
      );
    }
    expect(codes("[Link]\nID_NET_NAME_ALLOW_CUSTOM=yes\n", "systemd-network")).not.toContain(
      "unknown-setting",
    );
    expect(
      analyze(parse("[Component]\nConditionArchitecture=x86-64\n", "systemd-config"), {
        targetVersion: "auto",
      }).map(({ code }) => code),
    ).not.toContain("setting-unavailable");
  });

  it.each([
    ["[Coredump]\nCompress=perhaps\n", "systemd-config"],
    ["[Coredump]\nExternalSizeMax=many\n", "systemd-config"],
    ["[Journal]\nMaxFileSec=soon\n", "systemd-config"],
    ["[Coredump]\nJournalSizeMax=huge\n", "systemd-config"],
    ["[Delegate]\nDNS=***\n", "systemd-config"],
  ] as const)("rejects invalid typed value in %s", (source, dialect) => {
    expect(codes(source, dialect)).toContain("invalid-value");
  });

  it("requires only genuinely mandatory unit and Quadlet sections", () => {
    expect(codes("[Unit]\nDescription=x\n", "systemd-unit", "file:///demo.service")).toContain(
      "missing-required-section",
    );
    expect(codes("[Unit]\nDescription=x\n", "systemd-unit", "file:///demo.target")).not.toContain(
      "missing-required-section",
    );
    expect(codes("[Unit]\nDescription=x\n", "podman-quadlet", "file:///demo.container")).toContain(
      "missing-required-section",
    );
    expect(
      codes("[Container]\nImage=alpine\n", "podman-quadlet", "file:///demo.container"),
    ).not.toContain("missing-required-section");
  });

  it("honors the diagnostic limit", () => {
    const document = parse("[Service]\nOne=x\nTwo=x\nThree=x\n", "systemd-unit");
    expect(analyze(document, { maxProblems: 2 })).toHaveLength(2);
  });
});

describe("record and JSON semantic analysis", () => {
  it.each([
    ["? /tmp/app\n", "systemd-tmpfiles", ["invalid-record-field"]],
    ["x user\n", "systemd-sysusers", ["invalid-record-field"]],
    ["maybe app.service\n", "systemd-preset", ["invalid-record-field"]],
    ["one two\n", "systemd-modules-load", ["invalid-column-count"]],
    [":name:M::magic:mask:interpreter\n", "systemd-binfmt", ["invalid-column-count"]],
    ["only\n", "systemd-table", ["invalid-column-count"]],
    ["BROKEN\n", "systemd-udev-rules", ["invalid-record-field"]],
  ] as const)("validates %s records", (source, dialect, expected) => {
    expect(codes(source, dialect as DialectId, "file:///etc/fstab")).toEqual(
      expect.arrayContaining([...expected]),
    );
  });

  it("validates simple assignment names", () => {
    expect(codes("9BAD=value\n", "systemd-environment")).toContain("invalid-environment-name");
    expect(codes("bad key=value\n", "systemd-sysctl")).toContain("invalid-sysctl-key");
    expect(codes("GOOD_NAME=value\n", "systemd-environment")).not.toContain(
      "invalid-environment-name",
    );
  });

  it("enforces format-specific JSON roots and stops after syntax errors", () => {
    expect(codes("{}", "systemd-json", "file:///app.pcrlock")).toContain("invalid-pcrlock-root");
    expect(codes("1", "systemd-json", "file:///app.rr")).toContain("invalid-rr-root");
    expect(codes("[]", "systemd-json", "file:///app.pcrlock")).not.toContain(
      "invalid-pcrlock-root",
    );
    expect(codes("{", "systemd-json", "file:///app.pcrlock")).toEqual(["systemd-json-syntax"]);
  });
});
