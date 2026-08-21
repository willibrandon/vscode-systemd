import { describe, expect, it } from "vitest";
import {
  configureRegistryChannel,
  definitionFor,
  definitionsFor,
  hwdbMatchPrefixes,
  hwdbProperties,
  hwdbPropertyFor,
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

  it("exposes source-generated hwdb properties and match prefixes", () => {
    expect(hwdbProperties.length).toBeGreaterThan(80);
    expect(hwdbMatchPrefixes).toEqual(
      expect.arrayContaining(["usb:", "mouse:usb:", "evdev:atkbd:", "sensor:modalias:"]),
    );
    expect(hwdbPropertyFor("ID_AUTOSUSPEND")).toMatchObject({
      valueKind: "boolean",
      choices: ["0", "1"],
    });
    expect(hwdbPropertyFor("KEYBOARD_KEY_a1")?.valueKind).toBe("keycode");
    expect(hwdbPropertyFor("EVDEV_ABS_00")?.valueKind).toBe("evdev-axis");
    expect(hwdbPropertyFor("CUSTOM_VENDOR_PROPERTY")).toBeUndefined();
  });

  it("filters sections and settings by concrete file kind", () => {
    expect(sectionsFor("systemd-unit", "systemd-unit:service")).toEqual([
      "Install",
      "Service",
      "Unit",
    ]);
    expect(sectionsFor("podman-quadlet", "podman-quadlet:volume")).toEqual([
      "Install",
      "Quadlet",
      "Service",
      "Unit",
      "Volume",
    ]);
    expect(sectionsFor("systemd-config", "systemd-config:system")).toEqual(["Manager"]);
    expect(sectionsFor("systemd-network", "systemd-network:link")).toEqual([
      "EnergyEfficientEthernet",
      "Link",
      "Match",
      "SR-IOV",
    ]);
    expect(sectionsFor("mkosi", "mkosi:uki-profile")).toEqual(["UKIProfile"]);

    expect(
      definitionFor("systemd-network", "Route", "Gateway", "systemd-network:link"),
    ).toBeUndefined();
    expect(
      definitionFor("systemd-network", "Link", "MACAddressPolicy", "systemd-network:link"),
    ).toBeDefined();
    expect(
      definitionFor("systemd-network", "Match", "Kind", "systemd-network:network"),
    ).toBeDefined();
    expect(
      definitionFor("systemd-network", "Match", "Type", "systemd-network:network"),
    ).toBeDefined();
    expect(sectionsFor("systemd-network", "systemd-network:network")).toContain("DHCP");
    expect(
      definitionFor("systemd-network", "DHCP", "UseDNS", "systemd-network:network"),
    ).toBeDefined();
    expect(
      definitionFor("systemd-network", "DHCP", "UseDNS", "systemd-network:link"),
    ).toBeUndefined();
    expect(
      definitionFor("systemd-config", "DHCP", "DUIDType", "systemd-config:networkd"),
    ).toBeDefined();
    expect(
      definitionFor("systemd-config", "Manager", "DefaultTimeoutStartSec", "systemd-config:system"),
    ).toBeDefined();
    expect(
      definitionFor(
        "systemd-config",
        "Manager",
        "DefaultTimeoutStartSec",
        "systemd-config:journald",
      ),
    ).toBeUndefined();
    expect(
      definitionsFor("podman-quadlet", "Unit", "podman-quadlet:container").some(
        ({ name }) => name === "ExecStart",
      ),
    ).toBe(false);
  });

  it("preserves predecessor issue regressions in generated stable metadata", () => {
    expect(definitionFor("systemd-unit", "Service", "User")).toBeDefined();
    expect(definitionFor("systemd-unit", "Service", "Group")).toBeDefined();
    expect(definitionFor("systemd-unit", "Unit", "StartLimitIntervalSec")).toBeDefined();
    expect(definitionFor("systemd-network", "Route", "GatewayOnLink")).toBeDefined();
    expect(definitionFor("systemd-network", "Network", "IPv4Forwarding")).toBeDefined();
    expect(definitionFor("systemd-network", "Network", "IPv6Forwarding")).toBeDefined();
    expect(definitionFor("systemd-network", "Network", "DHCP")?.choices).toEqual([
      "yes",
      "no",
      "ipv4",
      "ipv6",
    ]);
    expect(definitionFor("systemd-network", "Network", "DHCP")?.exclusiveChoices).toBe(true);
    expect(definitionFor("systemd-network", "Network", "LinkLocalAddressing")?.choices).toEqual([
      "yes",
      "no",
      "ipv4",
      "ipv6",
    ]);
    expect(definitionFor("systemd-unit", "Service", "KillSignal")?.choices).toEqual(
      expect.arrayContaining(["SIGTERM", "SIGKILL", "SIGRTMIN"]),
    );
    const capabilities = definitionFor("systemd-unit", "Service", "CapabilityBoundingSet");
    expect(capabilities?.valueKind).toBe("list");
    expect(capabilities?.choices).toEqual(
      expect.arrayContaining(["CAP_CHOWN", "CAP_SYS_ADMIN", "CAP_BPF"]),
    );
    const systemCalls = definitionFor("systemd-unit", "Service", "SystemCallFilter");
    expect(systemCalls?.valueKind).toBe("list");
    expect(systemCalls?.choices).toEqual(
      expect.arrayContaining(["@default", "@system-service", "@known"]),
    );
    const addressFamilies = definitionFor("systemd-unit", "Service", "RestrictAddressFamilies");
    expect(addressFamilies?.valueKind).toBe("list");
    expect(addressFamilies?.choices).toEqual(
      expect.arrayContaining(["AF_UNIX", "AF_INET", "AF_INET6"]),
    );
    expect(definitionFor("systemd-unit", "Service", "MemoryMax")?.valueKind).toBe("size");
    expect(definitionFor("systemd-unit", "Service", "EnvironmentFile")?.valueKind).toBe("path");
    expect(definitionFor("systemd-unit", "Service", "ExtensionImagePolicy")?.valueKind).toBe(
      "string",
    );
    expect(definitionFor("podman-quadlet", "Container", "CgroupsMode")).toBeDefined();
    expect(definitionFor("podman-quadlet", "Build", "ImageTag")).toBeDefined();
    expect(definitionFor("systemd-unit", "Install", "ExecStart")).toBeUndefined();
    expect(definitionFor("systemd-config", "Journal", "SystemMaxUse")?.valueKind).toBe("size");
    expect(definitionFor("systemd-config", "Resolve", "DNSSEC")?.valueKind).toBe("string");
    expect(definitionFor("mkosi", "Match", "Distribution")?.choices).toContain("fedora");
    expect(definitionFor("mkosi", "TriggerMatch", "PathExists")).toBeDefined();
    expect(definitionFor("mkosi", "Assert", "SystemdVersion")).toBeDefined();
    expect(definitionFor("mkosi", "TriggerAssert", "Image")).toBeDefined();
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

  it("preserves mkosi collection reset behavior and inheritance scopes", () => {
    expect(definitionFor("mkosi", "Include", "Include")).toMatchObject({
      assignmentMode: "append-no-reset",
    });
    expect(definitionFor("mkosi", "Config", "Profiles")).toMatchObject({
      assignmentMode: "append",
      mkosiScope: "inherit",
    });
    expect(definitionFor("mkosi", "Content", "Packages")).toMatchObject({
      assignmentMode: "append",
    });
    expect(definitionFor("mkosi", "Distribution", "Distribution")).toMatchObject({
      mkosiScope: "universal",
    });
    expect(definitionFor("mkosi", "Match", "Distribution")).toMatchObject({
      assignmentMode: "append-no-reset",
    });
    const historicalCache = definitionFor("mkosi", "Output", "CacheDirectory");
    expect(historicalCache?.since).toBe("16");
    expect(typeof historicalCache?.until).toBe("string");
    expect(definitionFor("mkosi", "Output", "KernelCommandLine")?.section).toBe("Content");
  });

  it("derives Quadlet types, choices, defaults, and repeat behavior from Podman", () => {
    expect(definitionFor("podman-quadlet", "Quadlet", "DefaultDependencies")).toMatchObject({
      valueKind: "boolean",
      summary: "DefaultDependencies in [Quadlet]. Defaults to true.",
    });
    expect(definitionFor("podman-quadlet", "Network", "NetworkDeleteOnStop")?.valueKind).toBe(
      "boolean",
    );
    expect(definitionFor("podman-quadlet", "Build", "ForceRM")?.valueKind).toBe("boolean");
    expect(definitionFor("podman-quadlet", "Volume", "User")?.valueKind).toBe("number");
    expect(definitionFor("podman-quadlet", "Container", "User")?.valueKind).toBe("string");
    expect(definitionFor("podman-quadlet", "Container", "AutoUpdate")).toMatchObject({
      choices: ["registry", "local"],
      exclusiveChoices: true,
    });
    expect(definitionFor("podman-quadlet", "Kube", "AutoUpdate")).toMatchObject({
      choices: ["registry", "local", "name/local", "name/registry"],
      assignmentMode: "append",
      exclusiveChoices: false,
    });
    expect(definitionFor("podman-quadlet", "Kube", "ExitCodePropagation")).toMatchObject({
      choices: ["all", "any", "none"],
      exclusiveChoices: true,
      summary: "ExitCodePropagation in [Kube]. Defaults to none.",
    });
    expect(definitionFor("podman-quadlet", "Container", "Notify")?.choices).toEqual([
      "yes",
      "no",
      "healthy",
    ]);
    expect(definitionFor("podman-quadlet", "Container", "Volume")?.assignmentMode).toBe("append");
  });

  it("switches between pinned stable data and the compact preview delta", () => {
    configureRegistryChannel("stable");
    const stableRevision = registryMetadata.upstream.mkosi;
    expect(definitionFor("mkosi", "Build", "ForeignUIDRange")).toBeUndefined();
    expect(hwdbPropertyFor("SOUND_FORM_FACTOR")?.choices).not.toContain("controller");

    configureRegistryChannel("preview");
    try {
      expect(definitionFor("mkosi", "Build", "ForeignUIDRange")?.since).toBe("preview");
      expect(registryMetadata.upstream.mkosi).not.toBe(stableRevision);
      expect(hwdbPropertyFor("SOUND_FORM_FACTOR")?.choices).toContain("controller");
    } finally {
      configureRegistryChannel("stable");
    }
  });
});
