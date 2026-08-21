import { describe, expect, it } from "vitest";

interface CycloneDxDocument {
  readonly bomFormat: string;
  readonly components?: readonly Readonly<Record<string, unknown>>[];
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly serialNumber: string;
  readonly specVersion: string;
}

interface ReleaseSbomModule {
  prepareCycloneDxForAttestation(value: unknown, seed: string): CycloneDxDocument;
}

const moduleUrl = new URL("../release-sbom.mjs", import.meta.url);
const releaseSbom = (await import(moduleUrl.href)) as ReleaseSbomModule;

describe("release SBOM preparation", () => {
  it("adds a deterministic RFC 4122 serial number to reproducible CycloneDX output", () => {
    const input = {
      bomFormat: "CycloneDX",
      metadata: { timestamp: "2026-08-12T00:00:00.000Z", tools: [{ name: "npm" }] },
      specVersion: "1.6",
      version: 1,
    };
    const seed = "willibrandon.systemd@0.1.5:0123456789abcdef";

    const first = releaseSbom.prepareCycloneDxForAttestation(input, seed);
    const second = releaseSbom.prepareCycloneDxForAttestation(input, seed);
    const different = releaseSbom.prepareCycloneDxForAttestation(input, `${seed}0`);

    expect(first).toMatchObject({ ...input, metadata: {} });
    expect(first.metadata).not.toHaveProperty("timestamp");
    expect(first.metadata).not.toHaveProperty("tools");
    expect(first.serialNumber).toMatch(
      /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(second.serialNumber).toBe(first.serialNumber);
    expect(different.serialNumber).not.toBe(first.serialNumber);
  });

  it("normalizes npm 11 and npm 12 CycloneDX naming differences", () => {
    const common = {
      bomFormat: "CycloneDX",
      specVersion: "1.6",
      version: 1,
    };
    const component = {
      "bom-ref": "@systemd/language-core@0.1.0",
      type: "library",
      version: "0.1.0",
      purl: "pkg:npm/%40systemd/language-core@0.1.0",
    };
    const npm11 = {
      ...common,
      metadata: {
        timestamp: "2026-08-21T00:00:00.000Z",
        tools: [{ vendor: "npm", name: "cli", version: "11.17.0" }],
        component: {
          "bom-ref": "systemd@0.1.0",
          type: "library",
          name: "vscode-systemd",
          version: "0.1.0",
          purl: "pkg:npm/systemd@0.1.0",
        },
      },
      components: [{ ...component, name: "language-core" }],
    };
    const npm12 = {
      ...common,
      metadata: {
        timestamp: "2026-08-21T01:00:00.000Z",
        tools: [{ vendor: "npm", name: "cli", version: "12.0.2" }],
        component: {
          ...npm11.metadata.component,
          name: "systemd",
        },
      },
      components: [{ ...component, name: "@systemd/language-core" }],
    };

    const fromNpm11 = releaseSbom.prepareCycloneDxForAttestation(npm11, "same-seed");
    const fromNpm12 = releaseSbom.prepareCycloneDxForAttestation(npm12, "same-seed");

    expect(fromNpm11).toEqual(fromNpm12);
    expect(fromNpm11.metadata?.["component"]).toMatchObject({ name: "systemd" });
    expect(fromNpm11.components?.[0]).toMatchObject({ name: "@systemd/language-core" });
  });

  it("rejects non-CycloneDX output before release attestation", () => {
    expect(() => releaseSbom.prepareCycloneDxForAttestation({}, "seed")).toThrow(
      "The generated SBOM is not a CycloneDX JSON document.",
    );
    expect(() =>
      releaseSbom.prepareCycloneDxForAttestation(
        { bomFormat: "CycloneDX", specVersion: 1.6 },
        "seed",
      ),
    ).toThrow("The generated SBOM is not a CycloneDX JSON document.");
  });
});
