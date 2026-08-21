import { describe, expect, it } from "vitest";
import { analyze, configureRegistryChannel, parse } from "../src/index.js";
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
      analyze(parse("[Service]\nCacheDirectoryAccounting=yes\n", "systemd-unit"), {
        targetVersion: "v255",
      }).map(({ code }) => code),
    ).toContain("setting-unavailable");
    expect(codes("[Build]\nPackageManagerTrees=/tmp/tree\n", "mkosi")).toContain(
      "deprecated-setting",
    );
  });

  it("applies section and directive rules for the concrete file kind", () => {
    expect(codes("[Socket]\nListenStream=1\n", "systemd-unit", "file:///demo.service")).toEqual(
      expect.arrayContaining(["unknown-section", "unknown-setting", "missing-required-section"]),
    );
    expect(codes("[Network]\nDHCP=yes\n", "systemd-network", "file:///10-app.link")).toEqual(
      expect.arrayContaining(["unknown-section", "unknown-setting"]),
    );
    expect(
      codes("[Manager]\nDefaultTimeoutStartSec=30s\n", "systemd-config", "file:///system.conf"),
    ).toEqual([]);
    expect(codes("[Resolve]\nDNS=1.1.1.1\n", "systemd-config", "file:///journald.conf")).toEqual(
      expect.arrayContaining(["unknown-section", "unknown-setting"]),
    );
    expect(codes("[Container]\nImage=example\n", "podman-quadlet", "file:///data.volume")).toEqual(
      expect.arrayContaining(["unknown-section", "unknown-setting"]),
    );
    const extensionSection = codes(
      "[X-Project]\nAnything=preserved\n",
      "systemd-unit",
      "file:///demo.service",
    );
    expect(extensionSection).not.toContain("unknown-section");
    expect(extensionSection).not.toContain("unknown-setting");
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

  it("compares ecosystem-specific target versions by every numeric component", () => {
    const quadlet = parse(
      "[Build]\nBuildArg=RELEASE=1\n",
      "podman-quadlet",
      "file:///workspace/image.build",
    );
    expect(
      analyze(quadlet, { targetVersions: { "podman-quadlet": "5.6.9" } }).map(({ code }) => code),
    ).toContain("setting-unavailable");
    expect(
      analyze(quadlet, { targetVersions: { "podman-quadlet": "5.10.0" } }).map(({ code }) => code),
    ).not.toContain("setting-unavailable");

    const mkosi = parse("[Build]\nBuildKey=key\n", "mkosi", "file:///workspace/mkosi.conf");
    expect(analyze(mkosi, { targetVersions: { mkosi: "25" } }).map(({ code }) => code)).toContain(
      "setting-unavailable",
    );
    expect(
      analyze(mkosi, { targetVersions: { mkosi: "26" } }).map(({ code }) => code),
    ).not.toContain("setting-unavailable");
  });

  it("validates explicit systemd enum values extracted from upstream manuals", () => {
    expect(
      codes(
        "[Link]\nActivationPolicy=always-up\n\n[Network]\nIPMasquerade=both\n",
        "systemd-network",
        "file:///workspace/example.network",
      ),
    ).not.toContain("invalid-value");
    expect(
      codes(
        "[Network]\nIPMasquerade=yes\n",
        "systemd-network",
        "file:///workspace/example.network",
      ),
    ).not.toContain("invalid-value");
    expect(
      codes(
        "[Link]\nActivationPolicy=automatic\n",
        "systemd-network",
        "file:///workspace/example.network",
      ),
    ).toContain("invalid-value");
    expect(
      codes(
        "[Service]\nStandardOutput=file:/var/log/example.log\n",
        "systemd-unit",
        "file:///workspace/example.service",
      ),
    ).not.toContain("invalid-value");
  });

  it("marks preview-only metadata unavailable for an explicit released target", () => {
    configureRegistryChannel("preview");
    const document = parse(
      "[Build]\nForeignUIDRange=1000\n",
      "mkosi",
      "file:///workspace/mkosi.conf",
    );

    try {
      expect(
        analyze(document, { targetVersions: { mkosi: "26" } }).map(({ code }) => code),
      ).toContain("setting-unavailable");
      expect(
        analyze(document, { targetVersions: { mkosi: "latest" } }).map(({ code }) => code),
      ).not.toContain("setting-unavailable");
    } finally {
      configureRegistryChannel("stable");
    }
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

  it.each([
    ["[Coredump]\nExternalSizeMax=2G\n", "systemd-config"],
    ["[Journal]\nMaxFileSec=1h 30min\n", "systemd-config"],
    ["[Coredump]\nJournalSizeMax=1.5 GiB\n", "systemd-config"],
    ["[Delegate]\nDNS=[2001:db8::1]:53\n", "systemd-config"],
  ] as const)("accepts valid typed value in %s", (source, dialect) => {
    expect(codes(source, dialect)).not.toContain("invalid-value");
  });

  it("covers systemd numeric, duration, size, address, and path forms", () => {
    for (const value of ["+42", "-0o17", "0xAf"]) {
      expect(codes("[Journal]\nRateLimitBurst=" + value + "\n", "systemd-config")).not.toContain(
        "invalid-value",
      );
    }
    for (const value of ["+", "0x", "0o8", "12x"]) {
      expect(codes("[Journal]\nRateLimitBurst=" + value + "\n", "systemd-config")).toContain(
        "invalid-value",
      );
    }
    for (const value of ["infinity", "-1.5 sec", "1 ms", "1h30min"]) {
      expect(codes("[Journal]\nMaxFileSec=" + value + "\n", "systemd-config")).not.toContain(
        "invalid-value",
      );
    }
    for (const value of ["+", "1.", "1unknown"]) {
      expect(codes("[Journal]\nMaxFileSec=" + value + "\n", "systemd-config")).toContain(
        "invalid-value",
      );
    }
    for (const value of ["infinity", "-42", "42B", "42%", "42K", "42KB", "42Ki", "42KiB"]) {
      expect(codes("[Coredump]\nJournalSizeMax=" + value + "\n", "systemd-config")).not.toContain(
        "invalid-value",
      );
    }
    for (const value of ["+", "1.", "1XB"]) {
      expect(codes("[Coredump]\nJournalSizeMax=" + value + "\n", "systemd-config")).toContain(
        "invalid-value",
      );
    }
    expect(codes("[Delegate]\nDNS=[::1]/64:53\n", "systemd-config")).not.toContain("invalid-value");
    for (const value of ["[]", "[abc", "x[abc]", "abc//24", "abc/", "abc/1234", "abc/x"]) {
      expect(codes("[Delegate]\nDNS=" + value + "\n", "systemd-config")).toContain("invalid-value");
    }
    expect(codes("[Build]\nBuildDirectory=/tmp/build\n", "mkosi")).not.toContain("invalid-value");
    expect(codes("[Build]\nBuildDirectory=/tmp/\0build\n", "mkosi")).toContain("invalid-value");
  });

  it("validates adversarial values in linear time", () => {
    const started = performance.now();
    expect(
      codes("[Journal]\nMaxFileSec=" + "000.".repeat(25_000) + "!\n", "systemd-config"),
    ).toContain("invalid-value");
    expect(codes("[Delegate]\nDNS=" + "0 ".repeat(50_000) + "!\n", "systemd-config")).not.toContain(
      "invalid-value",
    );
    expect(performance.now() - started).toBeLessThan(1_000);
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

  it.each([
    ["demo.artifact", "[Artifact]\n", 1],
    ["demo.build", "[Build]\n", 2],
    ["demo.container", "[Container]\n", 1],
    ["demo.image", "[Image]\n", 1],
    ["demo.kube", "[Kube]\n", 1],
  ])("reports missing converter inputs for %s", (filename, source, expected) => {
    const diagnostics = analyze(
      parse(source, "podman-quadlet", "file:///workspace/" + filename),
    ).filter(({ code }) => code === "missing-required-setting");
    expect(diagnostics).toHaveLength(expected);
  });

  it.each([
    ["demo.artifact", "[Artifact]\nArtifact=quay.io/example/artifact:latest\n"],
    ["demo.build", "[Build]\nImageTag=localhost/example:latest\nFile=/workspace/Containerfile\n"],
    ["demo.build", "[Build]\nImageTag=localhost/example:latest\nSetWorkingDirectory=/workspace\n"],
    [
      "demo.build",
      "[Build]\nImageTag=localhost/example:latest\n\n[Service]\nWorkingDirectory=/workspace\n",
    ],
    ["demo.container", "[Container]\nImage=quay.io/podman/hello:latest\n"],
    ["demo.container", "[Container]\nRootfs=/srv/container-root\n"],
    ["demo.image", "[Image]\nImage=quay.io/podman/hello:latest\n"],
    ["demo.kube", "[Kube]\nYaml=/workspace/workload.yaml\n"],
    ["demo.network", "[Network]\n"],
    ["demo.pod", "[Pod]\n"],
    ["demo.volume", "[Volume]\n"],
  ])("accepts complete converter inputs for %s", (filename, source) => {
    expect(codes(source, "podman-quadlet", "file:///workspace/" + filename)).not.toContain(
      "missing-required-setting",
    );
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

  it("accepts current tmpfiles types and modifiers and strict udev expressions", () => {
    expect(codes("w+ /tmp/app - - - - value\n", "systemd-tmpfiles")).not.toContain(
      "invalid-record-field",
    );
    expect(codes("f$ /tmp/app - - - - payload\n", "systemd-tmpfiles")).not.toContain(
      "invalid-record-field",
    );
    expect(codes('ENV{ID_MODEL} == "demo"\n', "systemd-udev-rules")).not.toContain(
      "invalid-record-field",
    );
    expect(codes('ENV{ID_MODEL == "demo"\n', "systemd-udev-rules")).toContain(
      "invalid-record-field",
    );
    expect(codes("f++ /tmp/app\n", "systemd-tmpfiles")).toContain("invalid-record-field");
    expect(codes("f# /tmp/app\n", "systemd-tmpfiles")).toContain("invalid-record-field");
    expect(codes("K$ /tmp/app - - - - cap_net_bind_service=ep\n", "systemd-tmpfiles")).toContain(
      "invalid-record-field",
    );
    expect(codes("L? /tmp/app - - - - /missing/target\n", "systemd-tmpfiles")).not.toContain(
      "invalid-record-field",
    );
    for (const operator of ["==", "!=", ":=", "+=", "-=", "="]) {
      expect(codes("ENV{ID_MODEL} " + operator + ' "demo"\n', "systemd-udev-rules")).not.toContain(
        "invalid-record-field",
      );
    }
    for (const expression of ["ENV{}=demo", "ENV", "ENV="]) {
      expect(codes(expression + "\n", "systemd-udev-rules")).toContain("invalid-record-field");
    }
    expect(codes("usb:v0001*\n ID_MODEL=Demo\n", "systemd-hwdb")).not.toContain(
      "invalid-record-field",
    );
  });

  it("validates non-INI records using their concrete upstream formats", () => {
    expect(
      codes(
        "f~ /root/.ssh/authorized_keys 0600 root root - SSH key with spaces\n",
        "systemd-tmpfiles",
        "file:///etc/tmpfiles.d/ssh.conf",
      ),
    ).toEqual([]);
    expect(codes('u! httpd 404 "HTTP User"\n', "systemd-sysusers")).toEqual([]);
    expect(codes("g! input -\n", "systemd-sysusers")).toContain("invalid-record-field");
    expect(codes("m httpd input description\n", "systemd-sysusers")).toContain(
      "invalid-record-field",
    );
    expect(
      codes(":DOSWin:M::MZ::/usr/bin/wine:\n", "systemd-binfmt", "file:///etc/binfmt.d/wine.conf"),
    ).toEqual([]);
    expect(codes(":bad:X::magic::/bin/true:PP\n", "systemd-binfmt")).toEqual([
      "invalid-record-field",
      "invalid-record-field",
    ]);
  });

  it.each([
    ["file:///etc/fstab", "UUID=abc / ext4 defaults 0 1\n"],
    ["file:///etc/crypttab", "home UUID=abc - luks\n"],
    ["file:///etc/veritytab", "usr /dev/data /dev/hash deadbeef auto\n"],
    ["file:///etc/integritytab", "home /dev/data - allow-discards\n"],
    ["file:///etc/clonetab", "clone /dev/source /dev/dest /dev/meta region-size=8K\n"],
  ] as const)("accepts the documented columns for %s", (uri, source) => {
    expect(codes(source, "systemd-table", uri)).not.toContain("invalid-column-count");
  });

  it("rejects table records using another table format's column count", () => {
    expect(codes("usr /dev/data /dev/hash\n", "systemd-table", "file:///etc/veritytab")).toContain(
      "invalid-column-count",
    );
    expect(codes("clone /dev/source\n", "systemd-table", "file:///etc/clonetab")).toContain(
      "invalid-column-count",
    );
  });

  it("validates positive and negative DNSSEC trust anchors", () => {
    expect(
      codes(
        ". IN DS 19036 8 2 49aac11d7b6f6446702e54a1607371607a1a41855200fd2ce1cdde32f24e8fb5\n",
        "systemd-dns-trust-anchor",
        "file:///etc/dnssec-trust-anchors.d/root.positive",
      ),
    ).toEqual([]);
    expect(
      codes(
        ". IN DNSKEY 257 3 8 AQIDBA==\n",
        "systemd-dns-trust-anchor",
        "file:///etc/dnssec-trust-anchors.d/root.positive",
      ),
    ).toEqual([]);
    expect(
      codes(
        "10.in-addr.arpa\nprivate.example\n",
        "systemd-dns-trust-anchor",
        "file:///etc/dnssec-trust-anchors.d/private.negative",
      ),
    ).toEqual([]);
    expect(
      codes(
        ". CH DS nope 999 999 xyz\n",
        "systemd-dns-trust-anchor",
        "file:///etc/dnssec-trust-anchors.d/bad.positive",
      ),
    ).toEqual([
      "invalid-record-field",
      "invalid-record-field",
      "invalid-record-field",
      "invalid-record-field",
      "invalid-record-field",
    ]);
  });

  it("validates concrete boot and single-value files", () => {
    expect(
      codes(
        "timeout 3\neditor no\nconsole-mode max\n",
        "systemd-boot",
        "file:///boot/loader/loader.conf",
      ),
    ).toEqual([]);
    expect(
      codes(
        "title Linux\nlinux /vmlinuz-linux\ninitrd /initramfs-linux.img\noptions quiet splash\n",
        "systemd-boot",
        "file:///boot/loader/entries/linux.conf",
      ),
    ).toEqual([]);
    expect(codes("unknown value\n", "systemd-boot", "file:///boot/loader/loader.conf")).toContain(
      "invalid-record-field",
    );
    expect(codes("BAD=value\n", "systemd-boot", "file:///etc/kernel/install.conf")).toContain(
      "unknown-boot-setting",
    );
    expect(codes("valid-host.example\n", "systemd-environment", "file:///etc/hostname")).toEqual(
      [],
    );
    expect(
      codes("one.example\ntwo.example\n", "systemd-environment", "file:///etc/hostname"),
    ).toContain("unexpected-extra-line");
  });

  it("enforces format-specific JSON roots and stops after syntax errors", () => {
    expect(codes("{}", "systemd-json", "file:///app.pcrlock")).toContain("invalid-pcrlock-root");
    expect(codes("1", "systemd-json", "file:///app.rr")).toContain("invalid-rr-root");
    expect(codes("[]", "systemd-json", "file:///app.pcrlock")).not.toContain(
      "invalid-pcrlock-root",
    );
    expect(codes("{", "systemd-json", "file:///app.pcrlock")).toEqual(["systemd-json-syntax"]);
  });

  it("validates .pcrlock records using systemd parser constraints", () => {
    const valid = JSON.stringify([
      {
        pcr: 7,
        digests: [{ hashAlg: "sha256", digest: "00" }, { hashAlg: "future-hash" }],
        content_type: "systemd",
        content: { string: "Secure Boot policy", eventType: "variable" },
      },
      { nv_index: 22_020_198, digests: [] },
    ]);
    expect(codes(valid, "systemd-json", "file:///etc/pcrlock.d/app.pcrlock")).toEqual([]);

    const diagnostics = codes(
      JSON.stringify([
        {
          pcr: 24,
          nv_index: 4_294_967_295,
          digests: [
            { hashAlg: "sha256", digest: "xyz" },
            { hashAlg: "SHA256", digest: "00" },
          ],
        },
        { content_type: "systemd", content: "wrong" },
      ]),
      "systemd-json",
      "file:///etc/pcrlock.d/app.pcrlock",
    );
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        "pcrlock-index-exclusive",
        "invalid-pcrlock-pcr",
        "invalid-pcrlock-nv-index",
        "invalid-pcrlock-digest",
        "duplicate-pcrlock-hash-algorithm",
        "pcrlock-index-required",
        "pcrlock-digests-required",
        "pcrlock-content-required",
      ]),
    );
  });

  it("validates all DNS record encodings supported by systemd-resolved", () => {
    const valid = JSON.stringify([
      { key: { name: "a.example", type: 1 }, address: [192, 0, 2, 1] },
      { key: { name: "aaaa.example", type: 28, class: 1 }, address: "2001:db8::1" },
      { key: { name: "alias.example", type: 5 }, name: "target.example" },
      { key: { name: "root.example", type: 2 }, name: "." },
    ]);
    expect(codes(valid, "systemd-json", "file:///etc/systemd/resolve/static.d/app.rr")).toEqual([]);

    const diagnostics = codes(
      JSON.stringify([
        { key: { name: "bad name", type: 1, class: 65_536 }, address: [300, 0, 0, 1] },
        { key: { name: "mx.example", type: 15 } },
        { key: { name: "alias.example", type: 5 } },
        null,
      ]),
      "systemd-json",
      "file:///etc/systemd/resolve/static.d/app.rr",
    );
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        "invalid-rr-name",
        "invalid-rr-class",
        "invalid-rr-address",
        "unsupported-rr-type",
        "invalid-rr-target-name",
        "invalid-rr-record",
      ]),
    );

    const source = '{"key":{"name":"a.example","type":1},"address":[300,0,0,1]}';
    const addressDiagnostic = analyze(
      parse(source, "systemd-json", "file:///etc/systemd/resolve/static.d/app.rr"),
    ).find(({ code }) => code === "invalid-rr-address");
    expect(source.slice(addressDiagnostic?.span.start, addressDiagnostic?.span.end)).toBe(
      "[300,0,0,1]",
    );
  });

  it("reports every malformed .pcrlock record shape without rejecting future hash algorithms", () => {
    const diagnostics = codes(
      JSON.stringify([
        null,
        { pcr: "7", digests: {}, content_type: 7 },
        {
          pcr: 0,
          digests: [
            null,
            {},
            { hashAlg: 7 },
            { hashAlg: "sha1" },
            { hashAlg: "future-hash", digest: false },
          ],
          content_type: "systemd",
          content: { string: 1, eventType: false },
        },
        { nv_index: 0, digests: [], content_type: "vendor" },
      ]),
      "systemd-json",
      "file:///etc/pcrlock.d/shapes.pcrlock",
    );

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        "invalid-pcrlock-record",
        "invalid-pcrlock-pcr",
        "invalid-pcrlock-digests",
        "invalid-pcrlock-content-type",
        "invalid-pcrlock-digest",
        "pcrlock-hash-algorithm-required",
        "invalid-pcrlock-content",
      ]),
    );
    expect(diagnostics.filter((code) => code === "pcrlock-hash-algorithm-required")).toHaveLength(
      2,
    );
    expect(diagnostics.filter((code) => code === "invalid-pcrlock-content")).toHaveLength(2);
  });

  it("accepts .pcrlock integer and digest boundaries", () => {
    const valid = JSON.stringify([
      { pcr: 0, digests: [{ hashAlg: "SHA1", digest: "" }] },
      { pcr: 23, digests: [{ hashAlg: "sha512", digest: "ff".repeat(64) }] },
      { nv_index: 4_294_967_294, digests: [{ hashAlg: "sha384", digest: "0123456789abcdef" }] },
    ]);
    expect(codes(valid, "systemd-json", "file:///etc/pcrlock.d/boundaries.pcrlock")).toEqual([]);
  });

  it("accepts every supported DNS JSON representation and DNS-name form", () => {
    const valid = JSON.stringify([
      { key: { name: "ipv4.example.", class: 0, type: 1 }, address: "192.0.2.1" },
      { key: { name: "bytes.example", class: 65_535, type: 1 }, address: [0, 255, 2, 1] },
      { key: { name: "full-v6.example", type: 28 }, address: "2001:db8:0:0:0:0:0:1" },
      { key: { name: "compressed-v6.example", type: 28 }, address: "2001:db8::1" },
      { key: { name: "embedded-v4.example", type: 28 }, address: "::ffff:192.0.2.1" },
      {
        key: { name: "v6-bytes.example", type: 28 },
        address: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 254, 255],
      },
      { key: { name: "ns.example", type: 2 }, name: "." },
      { key: { name: "alias.example", type: 5 }, name: "target.example." },
      { key: { name: "ptr.example", type: 12 }, name: "escaped\\032label.example" },
      { key: { name: "dname.example", type: 39 }, name: "target.example" },
    ]);
    expect(codes(valid, "systemd-json", "file:///etc/systemd/resolve/static.d/valid.rr")).toEqual(
      [],
    );

    const validObject = JSON.stringify({
      key: { name: "single.example", type: 1 },
      address: "203.0.113.4",
    });
    expect(
      codes(validObject, "systemd-json", "file:///etc/systemd/resolve/static.d/single.rr"),
    ).toEqual([]);
  });

  it("rejects malformed DNS keys, addresses, types, and names at their boundaries", () => {
    const overlongName = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}.x`;
    const invalid = JSON.stringify([
      {},
      { key: [] },
      { key: { name: "", type: 1 }, address: "192.0.2.1" },
      { key: { name: overlongName, type: 1 }, address: "192.0.2.1" },
      { key: { name: "bad/name", type: 1 }, address: "192.0.2.1" },
      { key: { name: "bad..name", type: 1 }, address: "192.0.2.1" },
      { key: { name: `${"a".repeat(64)}.example`, type: 1 }, address: "192.0.2.1" },
      { key: { name: "class.example", class: -1, type: 1 }, address: "192.0.2.1" },
      { key: { name: "class.example", class: 1.5, type: 1 }, address: "192.0.2.1" },
      { key: { name: "missing-type.example" } },
      { key: { name: "string-type.example", type: "1" } },
      { key: { name: "negative-type.example", type: -1 } },
      { key: { name: "large-type.example", type: 65_536 } },
      { key: { name: "fractional-type.example", type: 1.5 } },
      { key: { name: "unsupported.example", type: 16 } },
      { key: { name: "a.example", type: 1 }, address: "192.0.2" },
      { key: { name: "a.example", type: 1 }, address: "192.0.2.999" },
      { key: { name: "a.example", type: 1 }, address: "192.0.two.1" },
      { key: { name: "a.example", type: 1 }, address: [192, 0, 2] },
      { key: { name: "a.example", type: 1 }, address: [192, 0, 2, -1] },
      { key: { name: "a.example", type: 1 }, address: [192, 0, 2, 1.5] },
      { key: { name: "aaaa.example", type: 28 }, address: "" },
      { key: { name: "aaaa.example", type: 28 }, address: "fe80::1%eth0" },
      { key: { name: "aaaa.example", type: 28 }, address: "2001:db8 ::1" },
      { key: { name: "aaaa.example", type: 28 }, address: "2001::db8::1" },
      { key: { name: "aaaa.example", type: 28 }, address: "2001:db8:zz::1" },
      { key: { name: "aaaa.example", type: 28 }, address: "2001:db8:0:0:0:0:1" },
      { key: { name: "aaaa.example", type: 28 }, address: "1:2:3:4:5:6:7:8:9" },
      { key: { name: "aaaa.example", type: 28 }, address: "192.0.2.1::" },
      { key: { name: "aaaa.example", type: 28 }, address: "::192.0.2.999" },
      { key: { name: "alias.example", type: 5 } },
      { key: { name: "alias.example", type: 5 }, name: "bad/name" },
    ]);
    const diagnostics = codes(
      invalid,
      "systemd-json",
      "file:///etc/systemd/resolve/static.d/invalid.rr",
    );

    expect(diagnostics.filter((code) => code === "rr-key-required")).toHaveLength(2);
    expect(diagnostics.filter((code) => code === "invalid-rr-name")).toHaveLength(5);
    expect(diagnostics.filter((code) => code === "invalid-rr-class")).toHaveLength(2);
    expect(diagnostics.filter((code) => code === "invalid-rr-type")).toHaveLength(5);
    expect(diagnostics).toContain("unsupported-rr-type");
    expect(diagnostics.filter((code) => code === "invalid-rr-address")).toHaveLength(15);
    expect(diagnostics.filter((code) => code === "invalid-rr-target-name")).toHaveLength(2);
  });

  it("does not apply format-specific checks to an unrecognized JSON filename", () => {
    expect(codes('{"arbitrary":true}', "systemd-json", "file:///workspace/data.json")).toEqual([]);
  });
});
