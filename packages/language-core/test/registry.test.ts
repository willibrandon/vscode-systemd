import { describe, expect, it } from "vitest";
import {
  configureRegistryChannel,
  definitionFor,
  definitionsFor,
  isDynamicDirective,
  registryDialect,
  sectionsFor,
  registryMetadata,
} from "../src/index.js";

describe("registry queries", () => {
  it("maps only registry-backed dialects", () => {
    for (const dialect of [
      "systemd-unit",
      "systemd-network",
      "systemd-config",
      "podman-quadlet",
      "mkosi",
    ] as const) {
      expect(registryDialect(dialect)).toBe(dialect);
    }
    expect(registryDialect("systemd-tmpfiles")).toBeUndefined();
  });

  it("looks up exact, wildcard, and inherited Quadlet directives", () => {
    expect(definitionFor("systemd-unit", "Service", "ExecStart")?.name).toBe("ExecStart");
    expect(definitionFor("systemd-unit", "Unit", "Documentation")?.section).toBe("Unit");
    expect(definitionFor("systemd-unit", "Service", "Documentation")).toBeUndefined();
    expect(definitionFor("podman-quadlet", "Unit", "Description")?.dialect).toBe("systemd-unit");
    expect(definitionFor("podman-quadlet", "Container", "Image")?.dialect).toBe("podman-quadlet");
    expect(definitionFor("systemd-tmpfiles", null, "Type")).toBeUndefined();
    expect(definitionFor("systemd-unit", "Service", "DefinitelyUnknown")).toBeUndefined();
  });

  it("returns sorted section-aware definitions", () => {
    const service = definitionsFor("systemd-unit", "Service");
    expect(service.some((definition) => definition.name === "ExecStart")).toBe(true);
    expect(service.map(({ name }) => name)).toEqual(
      [...service.map(({ name }) => name)].sort((left, right) => left.localeCompare(right)),
    );
    expect(definitionsFor("systemd-unit").length).toBeGreaterThan(service.length);
    expect(definitionsFor("systemd-unit", null)).toHaveLength(
      definitionsFor("systemd-unit").length,
    );
    expect(definitionsFor("systemd-table")).toEqual([]);

    const quadletUnit = definitionsFor("podman-quadlet", "Unit");
    expect(quadletUnit.some((definition) => definition.name === "Description")).toBe(true);
  });

  it("returns known sections and accepts only generated dynamic names", () => {
    expect(sectionsFor("systemd-unit")).toContain("Service");
    expect(sectionsFor("podman-quadlet")).toEqual(
      expect.arrayContaining(["Unit", "Service", "Install", "Container"]),
    );
    expect(sectionsFor("systemd-binfmt")).toEqual([]);
    expect(isDynamicDirective("ID_NET_NAME_ALLOW_ENP5S0")).toBe(true);
    expect(isDynamicDirective("ID_NET_NAME_ALLOW_")).toBe(false);
    expect(isDynamicDirective("UnknownSetting")).toBe(false);
  });

  it("preserves predecessor issue regressions in generated stable metadata", () => {
    expect(definitionFor("systemd-unit", "Service", "User")).toBeDefined();
    expect(definitionFor("systemd-unit", "Service", "Group")).toBeDefined();
    expect(definitionFor("systemd-unit", "Unit", "StartLimitIntervalSec")).toBeDefined();
    expect(definitionFor("systemd-network", "Route", "GatewayOnLink")).toBeDefined();
    expect(definitionFor("systemd-network", "Network", "IPv4Forwarding")).toBeDefined();
    expect(definitionFor("systemd-network", "Network", "IPv6Forwarding")).toBeDefined();
    expect(definitionFor("podman-quadlet", "Container", "CgroupsMode")).toBeDefined();
    expect(definitionFor("podman-quadlet", "Build", "ImageTag")).toBeDefined();
    expect(definitionFor("systemd-unit", "Install", "ExecStart")).toBeUndefined();
    expect(definitionFor("systemd-config", "Journal", "SystemMaxUse")?.valueKind).toBe("size");
    expect(definitionFor("systemd-config", "Resolve", "DNSSEC")?.valueKind).toBe("string");
    expect(definitionFor("systemd-unit", "Service", "Type")?.choices).toEqual([
      "simple",
      "exec",
      "forking",
      "oneshot",
      "dbus",
      "notify",
      "notify-reload",
      "idle",
    ]);
    expect(definitionFor("systemd-network", "Link", "ActivationPolicy")?.choices).toEqual([
      "up",
      "always-up",
      "manual",
      "always-down",
      "down",
      "bound",
    ]);
    expect(definitionFor("systemd-network", "Link", "ActivationPolicy")?.exclusiveChoices).toBe(
      true,
    );
    expect(definitionFor("systemd-network", "Network", "IPMasquerade")?.exclusiveChoices).toBe(
      false,
    );
  });

  it("switches between pinned stable data and the compact preview delta", () => {
    configureRegistryChannel("stable");
    const stableRevision = registryMetadata.upstream.mkosi;
    expect(definitionFor("mkosi", "Build", "ForeignUIDRange")).toBeUndefined();

    configureRegistryChannel("preview");
    try {
      expect(definitionFor("mkosi", "Build", "ForeignUIDRange")?.since).toBe("preview");
      expect(registryMetadata.upstream.mkosi).not.toBe(stableRevision);
    } finally {
      configureRegistryChannel("stable");
    }
  });
});
