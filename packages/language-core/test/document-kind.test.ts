import { describe, expect, it } from "vitest";
import { documentAllowsSection, fixedDocumentSections } from "../src/document-kind.js";
import { classifyDocument } from "../src/index.js";
import type { DialectId, DocumentKind } from "../src/index.js";

describe("document kind classification", () => {
  it.each([
    ["file:///etc/systemd/system/app.timer", "systemd-unit", "systemd-unit:timer"],
    ["file:///tmp/README", "systemd-unit", "systemd-unit:unknown"],
    ["file:///etc/systemd/network/10-lan.dnssd", "systemd-network", "systemd-network:dnssd"],
    ["file:///tmp/README", "systemd-network", "systemd-network:unknown"],
    ["file:///usr/lib/tmpfiles.d/app.conf", "systemd-tmpfiles", "systemd-tmpfiles:tmpfiles"],
    ["file:///usr/lib/sysusers.d/app.conf", "systemd-sysusers", "systemd-sysusers:sysusers"],
    ["file:///etc/udev/rules.d/50-app.rules", "systemd-udev-rules", "systemd-udev-rules:rules"],
    ["file:///usr/lib/udev/hwdb.d/20-app.hwdb", "systemd-hwdb", "systemd-hwdb:hwdb"],
    ["file:///etc/sysctl.d/app.conf", "systemd-sysctl", "systemd-sysctl:sysctl"],
    [
      "file:///etc/modules-load.d/app.conf",
      "systemd-modules-load",
      "systemd-modules-load:modules-load",
    ],
    ["file:///etc/binfmt.d/app.conf", "systemd-binfmt", "systemd-binfmt:binfmt"],
    ["file:///etc/systemd/system-preset/90-app.preset", "systemd-preset", "systemd-preset:preset"],
    ["file:///etc/fstab", "systemd-table", "systemd-table:fstab"],
    ["file:///etc/not-a-table", "systemd-table", "systemd-table:unknown"],
    [
      "file:///etc/dnssec-trust-anchors.d/app.positive",
      "systemd-dns-trust-anchor",
      "systemd-dns-trust-anchor:positive",
    ],
    [
      "file:///etc/dnssec-trust-anchors.d/app.negative",
      "systemd-dns-trust-anchor",
      "systemd-dns-trust-anchor:negative",
    ],
    ["file:///tmp/app.txt", "systemd-dns-trust-anchor", "systemd-dns-trust-anchor:unknown"],
    ["file:///etc/pcrlock.d/app.pcrlock", "systemd-json", "systemd-json:pcrlock"],
    ["file:///etc/systemd/resolve/static.d/app.rr", "systemd-json", "systemd-json:rr"],
    ["file:///etc/userdb/example.user", "systemd-json", "systemd-json:user"],
    ["file:///etc/userdb/example.group", "systemd-json", "systemd-json:group"],
    ["file:///etc/userdb/example:wheel.membership", "systemd-json", "systemd-json:membership"],
    ["file:///tmp/app.json", "systemd-json", "systemd-json:unknown"],
    ["file:///etc/containers/systemd/app.pod", "podman-quadlet", "podman-quadlet:pod"],
    ["file:///tmp/app.conf", "podman-quadlet", "podman-quadlet:unknown"],
  ] satisfies readonly (readonly [string, DialectId, DocumentKind])[])(
    "classifies %s",
    (uri, dialect, expected) => {
      expect(classifyDocument(uri, dialect)).toBe(expected);
    },
  );

  it.each([
    ["file:///etc/os-release", "systemd-environment:os-release"],
    ["file:///usr/lib/initrd-release", "systemd-environment:os-release"],
    ["file:///etc/hostname", "systemd-environment:hostname"],
    ["file:///etc/machine-info", "systemd-environment:machine-info"],
    ["file:///etc/locale.conf", "systemd-environment:locale"],
    ["file:///etc/vconsole.conf", "systemd-environment:vconsole"],
    ["file:///etc/environment.d/10-app.conf", "systemd-environment:environment"],
    [
      "file:///usr/lib/extension-release.d/extension-release.app",
      "systemd-environment:environment",
    ],
    ["file:///tmp/environment", "systemd-environment:unknown"],
  ] satisfies readonly (readonly [string, DocumentKind])[])(
    "classifies environment file %s",
    (uri, expected) => {
      expect(classifyDocument(uri, "systemd-environment")).toBe(expected);
    },
  );

  it.each([
    ["file:///boot/loader/entries/linux.conf", "systemd-boot:entry"],
    ["file:///boot/loader/loader.conf", "systemd-boot:loader"],
    ["file:///etc/kernel/cmdline", "systemd-boot:kernel-command-line"],
    ["file:///etc/kernel/entry-token", "systemd-boot:entry-token"],
    ["file:///etc/kernel/install.conf", "systemd-boot:kernel-install"],
    ["file:///etc/kernel/install.conf.d/20-layout.conf", "systemd-boot:kernel-install"],
    ["file:///tmp/boot.txt", "systemd-boot:unknown"],
  ] satisfies readonly (readonly [string, DocumentKind])[])(
    "classifies boot file %s",
    (uri, expected) => {
      expect(classifyDocument(uri, "systemd-boot")).toBe(expected);
    },
  );

  it.each([
    ["file:///workspace/mkosi.version", "mkosi:version"],
    ["file:///workspace/mkosi.uki-profiles/secure.conf", "mkosi:uki-profile"],
    ["file:///workspace/mkosi.initrd.conf/mkosi.conf", "mkosi:initrd"],
    ["file:///workspace/mkosi.initrd.conf", "mkosi:initrd"],
    ["file:///workspace/mkosi.tools.conf/mkosi.conf", "mkosi:tools"],
    ["file:///workspace/mkosi.tools.conf", "mkosi:tools"],
    ["file:///workspace/mkosi.local/mkosi.conf", "mkosi:local"],
    ["file:///workspace/mkosi.local.conf", "mkosi:local"],
    ["file:///workspace/mkosi.presets/server.conf", "mkosi:preset"],
    ["file:///workspace/mkosi.presets/server/mkosi.conf", "mkosi:preset"],
    ["file:///workspace/mkosi.profiles/server/mkosi.conf", "mkosi:profile"],
    ["file:///workspace/mkosi.images/server.conf", "mkosi:subimage"],
    ["file:///workspace/mkosi.conf.d/20-output.conf", "mkosi:drop-in"],
    ["file:///workspace/mkosi.conf", "mkosi:main"],
    ["file:///workspace/arbitrary.conf", "mkosi:generic"],
  ] satisfies readonly (readonly [string, DocumentKind])[])(
    "classifies mkosi file %s",
    (uri, expected) => {
      expect(classifyDocument(uri, "mkosi")).toBe(expected);
    },
  );

  it("recognizes configuration families and special configuration directories", () => {
    const configured = [
      "system",
      "user",
      "journald",
      "logind",
      "resolved",
      "timesyncd",
      "networkd",
      "coredump",
      "oomd",
      "homed",
      "pstore",
      "iocost",
      "journal-remote",
      "journal-upload",
      "udev",
      "sysext",
      "confext",
      "ukify",
      "uki",
    ] as const;
    for (const family of configured) {
      expect(classifyDocument(`file:///etc/systemd/${family}.conf`, "systemd-config")).toBe(
        `systemd-config:${family}`,
      );
    }
    expect(classifyDocument("file:///etc/systemd/systemd-sleep.conf", "systemd-config")).toBe(
      "systemd-config:sleep",
    );
    expect(classifyDocument("file:///etc/systemd/nspawn/app.nspawn", "systemd-config")).toBe(
      "systemd-config:nspawn",
    );
    expect(classifyDocument("file:///workspace/mkosi.repart/10-root.conf", "systemd-config")).toBe(
      "systemd-config:repart",
    );
    expect(classifyDocument("file:///etc/repart.d/10-root.conf", "systemd-config")).toBe(
      "systemd-config:repart",
    );
    expect(classifyDocument("file:///etc/sysupdate.d/app.conf", "systemd-config")).toBe(
      "systemd-config:sysupdate",
    );
    expect(
      classifyDocument("file:///etc/systemd/portable/profile/app.conf", "systemd-config"),
    ).toBe("systemd-config:portable-profile");
    expect(
      classifyDocument("file:///etc/systemd/oomd/rules.d/pressure.oomrule", "systemd-config"),
    ).toBe("systemd-config:oom-rule");
    expect(classifyDocument("file:///tmp/app.conf", "systemd-config")).toBe(
      "systemd-config:generic",
    );
  });

  it("normalizes encoded paths, drop-in owners, template suffixes, and malformed URI escapes", () => {
    expect(
      classifyDocument(
        "file:///C%3A/work/app.service.d/override.conf.ignore.j2?generated=yes#fragment",
        "systemd-unit",
      ),
    ).toBe("systemd-unit:service");
    expect(classifyDocument("file:///tmp/not-an-owner.d/app.service", "systemd-unit")).toBe(
      "systemd-unit:service",
    );
    expect(classifyDocument("file:///tmp/app%ZZ.socket", "systemd-unit")).toBe(
      "systemd-unit:socket",
    );
    expect(classifyDocument("file:\\\\C:\\work\\app.network", "systemd-network")).toBe(
      "systemd-network:network",
    );
  });
});

describe("fixed document sections", () => {
  it.each([
    ["systemd-config:system", ["Manager"]],
    ["systemd-config:user", ["Manager"]],
    ["systemd-config:journald", ["Journal"]],
    ["systemd-config:logind", ["Login"]],
    ["systemd-config:resolved", ["Resolve"]],
    ["systemd-config:timesyncd", ["Time"]],
    [
      "systemd-config:networkd",
      ["Network", "DHCP", "DHCPv4", "DHCPv6", "DHCPServer", "DHCPRelay", "IPv6AcceptRA"],
    ],
    ["systemd-config:coredump", ["Coredump"]],
    ["systemd-config:oomd", ["OOM"]],
    ["systemd-config:oom-rule", ["Rule"]],
    ["systemd-config:homed", ["Home"]],
    ["systemd-config:pstore", ["PStore"]],
    ["systemd-config:sleep", ["Sleep"]],
    ["systemd-config:iocost", ["IOCost"]],
    ["systemd-config:journal-remote", ["Remote"]],
    ["systemd-config:journal-upload", ["Upload"]],
    ["systemd-config:udev", ["Udev"]],
    ["systemd-config:sysext", ["SysExt"]],
    ["systemd-config:confext", ["ConfExt"]],
    ["systemd-config:ukify", ["UKI"]],
    ["systemd-config:uki", ["UKI"]],
    ["systemd-config:nspawn", ["Exec", "Files", "Network"]],
    ["systemd-config:repart", ["Partition"]],
    ["systemd-config:sysupdate", ["Transfer", "Source", "Target", "Feature", "Component"]],
    ["systemd-config:portable-profile", ["Service"]],
  ] satisfies readonly (readonly [DocumentKind, readonly string[]])[])(
    "restricts %s to its parser sections",
    (kind, expected) => {
      expect(fixedDocumentSections(kind)).toEqual(expected);
    },
  );

  it("models unit, Quadlet, mkosi, unknown, and sectionless documents", () => {
    expect(fixedDocumentSections("systemd-unit:service")).toEqual(["Unit", "Service", "Install"]);
    expect(fixedDocumentSections("systemd-unit:target")).toEqual(["Unit", "Install"]);
    expect(fixedDocumentSections("systemd-unit:device")).toEqual(["Unit", "Install"]);
    expect(fixedDocumentSections("podman-quadlet:volume")).toEqual([
      "Unit",
      "Service",
      "Install",
      "Quadlet",
      "Volume",
    ]);
    expect(fixedDocumentSections("mkosi:uki-profile")).toEqual(["UKIProfile"]);
    expect(fixedDocumentSections("mkosi:version")).toEqual([]);
    expect(fixedDocumentSections("systemd-network:network")).toBeUndefined();
    expect(fixedDocumentSections("mkosi:main")).toBeUndefined();
    expect(fixedDocumentSections("systemd-config:generic")).toBeUndefined();
    expect(fixedDocumentSections("systemd-unit:unknown")).toBeUndefined();
    expect(fixedDocumentSections("systemd-tmpfiles:tmpfiles")).toEqual([]);
  });

  it("allows extension, dynamic ukify, known, and unconstrained sections only where appropriate", () => {
    expect(documentAllowsSection("systemd-unit:service", "X-Project")).toBe(true);
    expect(documentAllowsSection("systemd-config:ukify", "PCRSignature:kernel")).toBe(true);
    expect(documentAllowsSection("systemd-unit:service", "Service")).toBe(true);
    expect(documentAllowsSection("systemd-unit:service", "Socket")).toBe(false);
    expect(documentAllowsSection("systemd-network:network", "FutureSection")).toBe(true);
  });
});
