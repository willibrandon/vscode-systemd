import { describe, expect, it } from "vitest";
import {
  definitionFor,
  definitionsFor,
  isDynamicDirective,
  registryDialect,
  sectionsFor,
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
    expect(definitionFor("systemd-unit", "Service", "Documentation")?.section).toBe("*");
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
});
