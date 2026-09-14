import { describe, expect, it } from "vitest";

interface BundledPackagesModule {
  readonly getBundledPackages: (
    metafiles: readonly { inputs: Readonly<Record<string, unknown>> }[],
    lock: { packages: Readonly<Record<string, { version?: string }>> },
  ) => Set<string>;
}

const moduleUrl = new URL("../bundled-packages.mjs", import.meta.url);
const { getBundledPackages } = (await import(moduleUrl.href)) as BundledPackagesModule;

describe("bundled package identification", () => {
  it("resolves nested runtime packages instead of their parent or root development version", () => {
    const lock = {
      packages: {
        "node_modules/vscode-jsonrpc": { version: "9.0.2" },
        "node_modules/vscode-languageserver-protocol": { version: "3.18.2" },
        "node_modules/vscode-languageserver-protocol/node_modules/vscode-jsonrpc": {
          version: "9.0.1",
        },
      },
    };
    const inputs = {
      "packages/language-server/src/server.ts": {},
      "node_modules/vscode-languageserver-protocol/lib/common/api.js": {},
      "node_modules/vscode-languageserver-protocol/node_modules/vscode-jsonrpc/lib/common/api.js":
        {},
    };

    expect(getBundledPackages([{ inputs }, { inputs }], lock)).toEqual(
      new Set(["vscode-languageserver-protocol@3.18.2", "vscode-jsonrpc@9.0.1"]),
    );
  });

  it("retains distinct bundled versions and handles scoped packages at multiple depths", () => {
    const packages = {
      "node_modules/@scope/parent": { version: "1.0.0" },
      "node_modules/@scope/child": { version: "2.0.0" },
      "node_modules/@scope/parent/node_modules/@scope/child": { version: "1.0.0" },
      "node_modules/@scope/parent/node_modules/@scope/child/node_modules/leaf": {
        version: "3.0.0",
      },
    };
    const inputs = Object.fromEntries(
      Object.keys(packages).map((path) => [`${path}/index.js`, {}]),
    );

    expect(getBundledPackages([{ inputs }], { packages })).toEqual(
      new Set(["@scope/parent@1.0.0", "@scope/child@2.0.0", "@scope/child@1.0.0", "leaf@3.0.0"]),
    );
  });

  it.each([undefined, {}])("rejects missing nested lockfile versions: %j", (entry) => {
    const path = "node_modules/parent/node_modules/child";
    const packages: Record<string, { version?: string }> = {
      "node_modules/child": { version: "2.0.0" },
    };
    if (entry !== undefined) packages[path] = entry;

    expect(() =>
      getBundledPackages([{ inputs: { [`${path}/index.js`]: {} } }], { packages }),
    ).toThrow(`bundled dependency child has no versioned lockfile entry at ${path}`);
  });
});
