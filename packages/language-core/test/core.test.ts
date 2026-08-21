import { describe, expect, it } from "vitest";
import {
  analyze,
  applyTextEdits,
  definitionFor,
  detectDialect,
  directiveDefinitions,
  extractReferences,
  format,
  mergeConfigurations,
  parse,
  registryMetadata,
  renderEffectiveConfiguration,
} from "../src/index.js";

describe("generated registry", () => {
  it("contains authoritative systemd, Quadlet, and mkosi data", () => {
    expect(directiveDefinitions.length).toBeGreaterThan(3000);
    expect(new Set(directiveDefinitions.map((entry) => entry.dialect))).toEqual(
      new Set(["systemd-unit", "systemd-network", "systemd-config", "podman-quadlet", "mkosi"]),
    );
    expect(registryMetadata.quadletExtensions).toContain(".artifact");
    expect(registryMetadata.upstream.systemd).toMatch(/^[0-9a-f]{40}$/u);
    expect(definitionFor("systemd-unit", "Unit", "Description")?.valueKind).toBe("string");
  });
});

describe("dialect detection", () => {
  it.each([
    ["file:///workspace/demo.service", "[Service]\nExecStart=/bin/true\n", "systemd-unit"],
    ["file:///workspace/demo.service.backup", "[Service]\n", "systemd-unit"],
    ["file:///workspace/demo.timer.d/override.conf.ignore", "[Timer]\n", "systemd-unit"],
    ["file:///etc/systemd/network/20-lan.network", "[Network]\nDHCP=yes\n", "systemd-network"],
    [
      "file:///workspace/containers/systemd/app.network",
      "[Network]\nNetworkName=app\n",
      "podman-quadlet",
    ],
    ["file:///workspace/app.container", "[Container]\nImage=alpine\n", "podman-quadlet"],
    ["file:///workspace/mkosi.conf", "[Distribution]\nDistribution=fedora\n", "mkosi"],
    ["file:///etc/tmpfiles.d/app.conf", "d /run/app 0755 app app -\n", "systemd-tmpfiles"],
    [
      "file:///etc/udev/rules.d/90-app.rules",
      'ACTION=="add", TAG+="systemd"\n',
      "systemd-udev-rules",
    ],
    ["file:///etc/systemd/pcrlock.d/app.pcrlock", "[]\n", "systemd-json"],
  ] as const)("%s is %s", (uri, source, expected) => {
    expect(detectDialect(uri, source)).toBe(expected);
  });
});

describe("systemd parser and analyzer", () => {
  it("implements systemd continuation and comment semantics", () => {
    const document = parse(
      [
        "[Service]",
        "ExecStart=/bin/echo first \\",
        "  # ignored during continuation",
        "  second#literal",
        "",
      ].join("\n"),
      "systemd-unit",
      "file:///workspace/demo.service",
    );
    const assignment = document.nodes.find((node) => node.kind === "assignment");
    expect(assignment?.kind).toBe("assignment");
    if (assignment?.kind === "assignment") {
      expect(assignment.value).toBe("/bin/echo first second#literal");
      expect(assignment.physicalLines).toEqual([1, 2, 3]);
    }
    expect(analyze(document)).toEqual([]);
  });

  it("diagnoses unknown and invalid settings without treating inline # as a comment", () => {
    const document = parse(
      "[Service]\nExecStart=/bin/echo # literal\nDefinitelyWrong=yes\nDynamicUser=maybe\n",
      "systemd-unit",
      "file:///workspace/demo.service",
    );
    const diagnostics = analyze(document);
    expect(diagnostics.map(({ code }) => code)).toContain("unknown-setting");
    expect(diagnostics.map(({ code }) => code)).toContain("invalid-value");
    const exec = document.nodes.find(
      (node) => node.kind === "assignment" && node.name === "ExecStart",
    );
    expect(exec?.kind === "assignment" ? exec.value : "").toContain("# literal");
  });

  it("tolerates template islands and validates record dialects", () => {
    expect(
      analyze(
        parse(
          "[Service]\nUser=<%= @user %>\nExecStart={{ command }}\n",
          "systemd-unit",
          "file:///workspace/app.service.erb",
        ),
      ),
    ).toEqual([]);
    expect(
      analyze(parse("z /run/app\n", "systemd-tmpfiles", "file:///etc/tmpfiles.d/app.conf")).map(
        ({ code }) => code,
      ),
    ).not.toContain("invalid-column-count");
    expect(
      analyze(parse("wat app\n", "systemd-sysusers", "file:///etc/sysusers.d/app.conf")).map(
        ({ code }) => code,
      ),
    ).toContain("invalid-record-field");
  });
});

describe("formatting and workspace semantics", () => {
  it("formats conservatively without reordering or changing values", () => {
    const source = "[Service]   \nExecStart = /bin/echo value # literal   \n";
    const document = parse(source, "systemd-unit", "file:///workspace/app.service");
    const formatted = applyTextEdits(source, format(document));
    expect(formatted).toBe("[Service]\nExecStart=/bin/echo value # literal\n");
  });

  it("extracts references and renders effective provenance", () => {
    const base = parse(
      "[Unit]\nRequires=network.target dbus.socket\nDocumentation=file:/etc/app.md https://example.test/help\n[Service]\nEnvironment=ONE=1\n",
      "systemd-unit",
      "file:///workspace/app.service",
    );
    const dropIn = parse(
      "[Service]\nEnvironment=\nEnvironment=TWO=2\n",
      "systemd-unit",
      "file:///workspace/app.service.d/override.conf",
    );
    const references = extractReferences(base);
    expect(references.map(({ target }) => target)).toEqual([
      "network.target",
      "dbus.socket",
      "file:/etc/app.md",
      "https://example.test/help",
    ]);
    for (const reference of references) {
      expect(base.source.slice(reference.span.start, reference.span.end)).toBe(reference.target);
    }
    const rendered = renderEffectiveConfiguration(mergeConfigurations([base, dropIn]));
    expect(rendered).toContain("Environment=TWO=2");
    expect(rendered).not.toContain("Environment=ONE=1");
    expect(rendered).toContain("override.conf");
  });
});
