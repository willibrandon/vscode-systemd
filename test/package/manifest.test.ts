import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
interface Manifest {
  readonly name: string;
  readonly publisher: string;
  readonly license: string;
  readonly private?: boolean;
  readonly repository: { readonly url: string };
  readonly icon: string;
  readonly activationEvents?: readonly string[];
  readonly contributes: {
    readonly commands: readonly { readonly command: string }[];
    readonly views: {
      readonly explorer: readonly { readonly id: string; readonly name: string }[];
    };
  };
}

const manifest = JSON.parse(
  await readFile(resolve(root, "package.json"), "utf8"),
) as unknown as Manifest;

describe("extension manifest", () => {
  it("uses the intended public identity", () => {
    expect(manifest).toMatchObject({
      name: "systemd",
      publisher: "willibrandon",
      license: "MIT",
    });
    expect(manifest.private).not.toBe(true);
    expect(manifest.repository.url).toBe("https://github.com/willibrandon/vscode-systemd.git");
  });

  it("contributes every command it implements", () => {
    const commands = manifest.contributes.commands.map((command) => command.command);
    expect(commands).toEqual(
      expect.arrayContaining([
        "systemd.validateWithInstalledTools",
        "systemd.showEffectiveConfiguration",
        "systemd.showDependencyGraph",
        "systemd.createDropIn",
        "systemd.selectDialect",
        "systemd.openDocumentation",
        "systemd.refreshIndex",
        "systemd.restartLanguageServer",
        "systemd.showLanguageServerOutput",
      ]),
    );
  });

  it("relies on generated activation events from contributions", () => {
    expect(manifest.activationEvents).toBeUndefined();
  });

  it("contributes the Systemd Explorer in the standard Explorer container", () => {
    expect(manifest.contributes.views.explorer).toContainEqual({
      id: "systemd.explorer",
      name: "Systemd",
    });
  });

  it("uses a small deterministic PNG icon", async () => {
    const icon = await readFile(resolve(root, manifest.icon));
    expect([...icon.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect((await stat(resolve(root, manifest.icon))).size).toBeLessThan(64 * 1024);
  });
});
