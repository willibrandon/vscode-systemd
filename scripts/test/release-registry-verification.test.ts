import { describe, expect, it } from "vitest";

interface ExpectedRelease {
  readonly name: string;
  readonly preRelease: boolean;
  readonly publisher: string;
  readonly sha256: string;
  readonly version: string;
}

interface MarketplaceReleaseModule {
  isMarketplacePropagationError(error: unknown): boolean;
  isExpectedMarketplaceRelease(metadata: unknown, expected: ExpectedRelease): boolean;
  waitForMarketplaceInstallation(options: {
    readonly attempts: number;
    readonly delay: () => Promise<void>;
    readonly install: () => Promise<void>;
  }): Promise<void>;
  waitForMarketplaceRelease(options: {
    readonly attempts: number;
    readonly delay: () => Promise<void>;
    readonly expected: ExpectedRelease;
    readonly query: () => Promise<unknown>;
  }): Promise<unknown>;
}

interface OpenVsxReleaseModule {
  isExpectedOpenVsxRelease(metadata: unknown, expected: ExpectedRelease): boolean;
  waitForOpenVsxRelease(options: {
    readonly attempts: number;
    readonly delay: () => Promise<void>;
    readonly expected: ExpectedRelease;
    readonly query: () => Promise<unknown>;
    readonly readSha256: (metadata: unknown) => Promise<string>;
  }): Promise<unknown>;
}

const marketplace = (await import(
  new URL("../verify-marketplace-release.mjs", import.meta.url).href
)) as MarketplaceReleaseModule;
const openVsx = (await import(
  new URL("../verify-open-vsx-release.mjs", import.meta.url).href
)) as OpenVsxReleaseModule;
const expected = {
  publisher: "willibrandon",
  name: "systemd",
  version: "0.1.0",
  preRelease: true,
  sha256: "a".repeat(64),
} as const;

describe("Marketplace release verification", () => {
  it("requires the exact public, validated identity, channel, and checksum", () => {
    expect(marketplace.isExpectedMarketplaceRelease(marketplaceMetadata(), expected)).toBe(true);
    for (const candidate of [
      marketplaceMetadata({ publisher: { publisherName: "other" } }),
      marketplaceMetadata({ extensionName: "other" }),
      marketplaceMetadata({ flags: 4 }),
      marketplaceMetadata({ flags: 256 }),
      marketplaceMetadata({ version: "0.2.0" }),
      marketplaceMetadata({ preRelease: false }),
      marketplaceMetadata({ sha256: "b".repeat(64) }),
      marketplaceMetadata({ versionFlags: 0 }),
      undefined,
    ]) {
      expect(marketplace.isExpectedMarketplaceRelease(candidate, expected)).toBe(false);
    }
  });

  it("retries stale metadata and retains the final bounded failure", async () => {
    const responses: unknown[] = [
      new Error("temporary"),
      marketplaceMetadata({ version: "0.0.9" }),
      marketplaceMetadata(),
    ];
    let queries = 0;
    let delays = 0;
    await expect(
      marketplace.waitForMarketplaceRelease({
        attempts: 4,
        delay: () => {
          delays += 1;
          return Promise.resolve();
        },
        expected,
        query: () => {
          const result = responses[queries++];
          return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
        },
      }),
    ).resolves.toEqual(responses[2]);
    expect({ queries, delays }).toEqual({ queries: 3, delays: 2 });

    let failure: unknown;
    try {
      await marketplace.waitForMarketplaceRelease({
        attempts: 2,
        delay: () => Promise.resolve(),
        expected,
        query: () => Promise.reject(new Error("still unavailable")),
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) throw new Error("Expected Marketplace verification failure.");
    expect(failure.message).toBe("Marketplace release verification failed after 2 attempts.");
    expect(failure.cause).toBeInstanceOf(Error);
    if (!(failure.cause instanceof Error)) throw new Error("Expected retained Marketplace cause.");
    expect(failure.cause.message).toBe("still unavailable");
  });

  it("retries only Marketplace propagation failures during clean installation", async () => {
    let installs = 0;
    await marketplace.waitForMarketplaceInstallation({
      attempts: 3,
      delay: () => Promise.resolve(),
      install: () => {
        installs += 1;
        return installs < 3
          ? Promise.reject(marketplaceInstallError("Extension 'willibrandon.systemd' not found."))
          : Promise.resolve();
      },
    });
    expect(installs).toBe(3);

    const activationFailure = new Error("activation failed");
    await expect(
      marketplace.waitForMarketplaceInstallation({
        attempts: 3,
        delay: () => Promise.resolve(),
        install: () => Promise.reject(activationFailure),
      }),
    ).rejects.toBe(activationFailure);
    expect(marketplace.isMarketplacePropagationError(activationFailure)).toBe(false);
  });
});

describe("Open VSX release verification", () => {
  it("requires the exact identity, version, channel, platform, and registry checksum URL", () => {
    expect(openVsx.isExpectedOpenVsxRelease(openVsxMetadata(), expected)).toBe(true);
    for (const candidate of [
      openVsxMetadata({ namespace: "other" }),
      openVsxMetadata({ name: "other" }),
      openVsxMetadata({ version: "0.2.0" }),
      openVsxMetadata({ preRelease: false }),
      openVsxMetadata({ targetPlatform: "linux-x64" }),
      openVsxMetadata({ downloadable: false }),
      openVsxMetadata({ files: { sha256: "https://example.test/package.sha256" } }),
      undefined,
    ]) {
      expect(openVsx.isExpectedOpenVsxRelease(candidate, expected)).toBe(false);
    }
  });

  it("retries stale metadata and checksums and stops at the configured bound", async () => {
    const responses: unknown[] = [
      new Error("temporary"),
      openVsxMetadata({ version: "0.0.9" }),
      openVsxMetadata(),
      openVsxMetadata(),
    ];
    const checksums = ["b".repeat(64), expected.sha256];
    let queries = 0;
    let checksumReads = 0;
    let delays = 0;
    await expect(
      openVsx.waitForOpenVsxRelease({
        attempts: 5,
        delay: () => {
          delays += 1;
          return Promise.resolve();
        },
        expected,
        query: () => {
          const result = responses[queries++];
          return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
        },
        readSha256: () => Promise.resolve(checksums[checksumReads++] ?? ""),
      }),
    ).resolves.toEqual(responses[3]);
    expect({ queries, checksumReads, delays }).toEqual({
      queries: 4,
      checksumReads: 2,
      delays: 3,
    });

    let failure: unknown;
    try {
      await openVsx.waitForOpenVsxRelease({
        attempts: 2,
        delay: () => Promise.resolve(),
        expected,
        query: () => Promise.reject(new Error("still unavailable")),
        readSha256: () => Promise.resolve(expected.sha256),
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) throw new Error("Expected Open VSX verification failure.");
    expect(failure.message).toBe("Open VSX release verification failed after 2 attempts.");
    expect(failure.cause).toBeInstanceOf(Error);
    if (!(failure.cause instanceof Error)) throw new Error("Expected retained Open VSX cause.");
    expect(failure.cause.message).toBe("still unavailable");
  });
});

function marketplaceInstallError(stderr: string): Error & { readonly stderr: string } {
  return Object.assign(new Error("VS Code extension installation failed."), { stderr });
}

function marketplaceMetadata(overrides: Record<string, unknown> = {}): unknown {
  const version = overrides["version"] ?? expected.version;
  const preRelease =
    typeof overrides["preRelease"] === "boolean" ? overrides["preRelease"] : expected.preRelease;
  const sha256 = overrides["sha256"] ?? expected.sha256;
  const versionFlags = overrides["versionFlags"] ?? 1;
  const metadataOverrides: Record<string, unknown> = { ...overrides };
  delete metadataOverrides["version"];
  delete metadataOverrides["preRelease"];
  delete metadataOverrides["sha256"];
  delete metadataOverrides["versionFlags"];
  return {
    flags: 260,
    publisher: { publisherName: expected.publisher },
    extensionName: expected.name,
    versions: [
      {
        flags: versionFlags,
        version,
        properties: [
          ...(preRelease ? [{ key: "Microsoft.VisualStudio.Code.PreRelease", value: "true" }] : []),
          { key: "Microsoft.VisualStudio.Services.VsixSha256", value: sha256 },
        ],
      },
    ],
    ...metadataOverrides,
  };
}

function openVsxMetadata(overrides: Record<string, unknown> = {}): unknown {
  return {
    namespace: expected.publisher,
    name: expected.name,
    version: expected.version,
    preRelease: expected.preRelease,
    targetPlatform: "universal",
    downloadable: true,
    files: {
      sha256: `https://open-vsx.org/api/${expected.publisher}/${expected.name}/${expected.version}/file/package.sha256`,
    },
    ...overrides,
  };
}
