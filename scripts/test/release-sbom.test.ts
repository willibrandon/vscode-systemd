import { describe, expect, it } from "vitest";

interface CycloneDxDocument {
  readonly bomFormat: string;
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

    expect(first).toMatchObject({ ...input, metadata: { tools: [{ name: "npm" }] } });
    expect(first.metadata).not.toHaveProperty("timestamp");
    expect(first.serialNumber).toMatch(
      /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(second.serialNumber).toBe(first.serialNumber);
    expect(different.serialNumber).not.toBe(first.serialNumber);
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
