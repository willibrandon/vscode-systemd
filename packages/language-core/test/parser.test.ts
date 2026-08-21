import { describe, expect, it } from "vitest";
import { detectDialect, parse } from "../src/index.js";
import type { DialectId } from "../src/index.js";

describe("complete dialect recognition", () => {
  it.each([
    ["file:///etc/systemd/system/demo.socket", "", "systemd-unit"],
    ["file:///etc/systemd/network/10-lan.netdev", "", "systemd-network"],
    ["file:///etc/systemd/journald.conf", "", "systemd-config"],
    ["file:///etc/systemd/journald@audit.conf", "", "systemd-config"],
    ["file:///etc/systemd/journald@audit.conf.d/override.conf", "", "systemd-config"],
    ["file:///usr/lib/tmpfiles.d/app.conf", "", "systemd-tmpfiles"],
    ["file:///usr/lib/sysusers.d/app.conf", "", "systemd-sysusers"],
    ["file:///etc/udev/rules.d/90-app.rules", "", "systemd-udev-rules"],
    ["file:///usr/lib/udev/hwdb.d/20-app.hwdb", "", "systemd-hwdb"],
    ["file:///etc/environment.d/10-app.conf", "", "systemd-environment"],
    ["file:///etc/hostname", "", "systemd-environment"],
    ["file:///etc/sysctl.d/10-app.conf", "", "systemd-sysctl"],
    ["file:///etc/modules-load.d/app.conf", "", "systemd-modules-load"],
    ["file:///etc/binfmt.d/app.conf", "", "systemd-binfmt"],
    ["file:///etc/systemd/system-preset/90-app.preset", "", "systemd-preset"],
    ["file:///etc/fstab", "", "systemd-table"],
    ["file:///boot/loader/entries/linux.conf", "", "systemd-boot"],
    ["file:///etc/kernel/install.conf", "", "systemd-boot"],
    ["file:///etc/kernel/install.conf.d/10-layout.conf", "", "systemd-boot"],
    ["file:///etc/dnssec-trust-anchors.d/example.positive", "", "systemd-dns-trust-anchor"],
    ["file:///etc/systemd/pcrlock.d/app.pcrlock", "[]", "systemd-json"],
    ["file:///etc/containers/systemd/app.volume", "", "podman-quadlet"],
    ["file:///workspace/mkosi.profiles/server/mkosi.conf", "", "mkosi"],
    ["file:///workspace/mkosi.profiles/debug", "", "mkosi"],
    ["file:///workspace/mkosi.images/initrd", "", "mkosi"],
    ["file:///workspace/mkosi.local/mkosi.conf.d/local.conf", "", "mkosi"],
    ["file:///workspace/mkosi.tools.conf/mkosi.conf", "", "mkosi"],
    ["file:///workspace/mkosi.uki-profiles/secure.conf", "", "mkosi"],
    ["file:///workspace/mkosi.repart/10-root.conf", "", "systemd-config"],
  ] as const)("recognizes %s", (uri, source, expected) => {
    expect(detectDialect(uri, source)).toBe(expected);
  });

  it("handles preferred dialects, encoded Windows paths, drop-ins, and content fallback", () => {
    expect(detectDialect("untitled:Untitled-1", "", "systemd-network")).toBe("systemd-network");
    expect(
      detectDialect("file:///C%3A/work/demo.service.d/override.conf.ignore", "[Service]\n"),
    ).toBe("systemd-unit");
    expect(detectDialect("untitled:unit", "[Service]\nExecStart=/bin/true\n")).toBe("systemd-unit");
    expect(detectDialect("untitled:network", "[DHCPv6]\nUseDNS=yes\n")).toBe("systemd-network");
    expect(detectDialect("untitled:quadlet", "[Pod]\nPodName=demo\n")).toBe("podman-quadlet");
    expect(detectDialect("untitled:mkosi", "[Output]\nFormat=disk\n")).toBe("mkosi");
    expect(detectDialect("untitled:unknown", "plain text\n")).toBeUndefined();
  });
});

describe("lossless parsers", () => {
  it("represents every INI line and reports malformed input", () => {
    const source =
      "\uFEFF\n  # comment\n{{ template }}\n[ Service ]\nDescription = demo\\\n  continued\n[broken\nNoEquals\n9Invalid=value\nEmpty=\n";
    const document = parse(source, "systemd-unit", "file:///demo.service");
    expect(document.nodes.map(({ kind }) => kind)).toEqual([
      "blank",
      "comment",
      "record",
      "section",
      "assignment",
      "invalid",
      "invalid",
      "invalid",
      "assignment",
      "blank",
    ]);
    expect(document.diagnostics).toHaveLength(3);
    expect(document.lineStarts).toHaveLength(11);
    expect(document.nodes[4]).toMatchObject({
      kind: "assignment",
      name: "Description",
      value: "democontinued",
      physicalLines: [4, 5],
    });
  });

  it("preserves CRLF, escaped separators, quoted fields, and binfmt delimiters", () => {
    const udev = parse(
      'ACTION=="add,change", ENV{VALUE}="a\\,b", TAG+="systemd"\r\n',
      "systemd-udev-rules",
    );
    expect(udev.nodes[0]).toMatchObject({
      kind: "record",
      fields: ['ACTION=="add,change"', 'ENV{VALUE}="a\\,b"', 'TAG+="systemd"'],
    });
    expect(parse(":name:M::magic:mask:/usr/bin/app:F\n", "systemd-binfmt").nodes[0]).toMatchObject({
      kind: "record",
      fields: ["name", "M", "", "magic", "mask", "/usr/bin/app", "F"],
    });
  });

  it("parses mkosi's indented multiline values and inline comments", () => {
    const source = [
      "[Content]",
      "Packages= # reset and append",
      "    systemd # required",
      "",
      "    bash",
      "KernelCommandLine=",
      "    enforcing=0",
      "    systemd.log_target=console",
      "Format=directory # inline comment",
      "",
    ].join("\n");
    const document = parse(source, "mkosi", "file:///workspace/mkosi.conf");

    expect(document.diagnostics).toEqual([]);
    expect(document.nodes.filter((node) => node.kind === "assignment")).toMatchObject([
      {
        name: "Packages",
        value: "systemd\nbash",
        physicalLines: [1, 2, 3, 4],
      },
      {
        name: "KernelCommandLine",
        value: "enforcing=0\nsystemd.log_target=console",
        physicalLines: [5, 6, 7],
      },
      { name: "Format", value: "directory", physicalLines: [8] },
    ]);
  });

  it("parses hwdb properties, simple assignments, templates, and records", () => {
    const hwdb = parse("usb:v0001*\n ID_BAD\n ID_MODEL = Demo\n", "systemd-hwdb");
    expect(hwdb.diagnostics).toHaveLength(1);
    expect(hwdb.nodes[2]).toMatchObject({ kind: "record", fields: ["ID_MODEL", "Demo"] });

    for (const dialect of ["systemd-environment", "systemd-sysctl", "systemd-boot"] as const) {
      expect(parse(" KEY = value \nword only\n", dialect).nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "assignment", name: "KEY", value: "value" }),
          expect.objectContaining({ kind: "record", fields: ["word", "only"] }),
        ]),
      );
    }
    expect(parse("{% if enabled %}\n", "systemd-tmpfiles").nodes[0]?.kind).toBe("record");
  });

  it.each(["systemd-tmpfiles", "systemd-sysusers", "systemd-modules-load"] as DialectId[])(
    "returns a source-covering tree for %s",
    (dialect) => {
      const source = "\n# comment\nvalue 'two words' escaped\\ value\n";
      const document = parse(source, dialect);
      expect(document.nodes.map(({ raw }) => raw).join("\n")).toBe(source);
      expect(document.nodes[2]).toMatchObject({
        kind: "record",
        fields: ["value", "'two words'", "escaped\\ value"],
      });
    },
  );

  it("validates JSON syntax while retaining a line tree", () => {
    const valid = parse("[\n  {}\n]\n", "systemd-json", "file:///app.pcrlock");
    expect(valid.diagnostics).toEqual([]);
    expect(valid.nodes).toHaveLength(4);
    const invalid = parse('{"broken": }', "systemd-json", "file:///app.rr");
    expect(invalid.diagnostics[0]).toMatchObject({
      code: "systemd-json-syntax",
      severity: "error",
    });
    expect(invalid.diagnostics[0]?.span.start).toBeGreaterThanOrEqual(0);
  });
});
