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
    readonly languages: readonly {
      readonly id: string;
      readonly configuration: string;
      readonly filenames?: readonly string[];
      readonly filenamePatterns?: readonly string[];
    }[];
    readonly views: {
      readonly explorer: readonly { readonly id: string; readonly name: string }[];
    };
    readonly jsonValidation: readonly { readonly fileMatch: string; readonly url: string }[];
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

  it("bundles schemas for every systemd JSON format with a defined structure", async () => {
    expect(manifest.contributes.jsonValidation).toEqual([
      {
        fileMatch: "*.pcrlock",
        url: "./schemas/systemd-pcrlock.schema.json",
      },
      { fileMatch: "*.rr", url: "./schemas/systemd-rr.schema.json" },
      { fileMatch: "*.user", url: "./schemas/systemd-user.schema.json" },
      { fileMatch: "*.group", url: "./schemas/systemd-group.schema.json" },
      {
        fileMatch: "*.membership",
        url: "./schemas/systemd-membership.schema.json",
      },
    ]);
    for (const { url } of manifest.contributes.jsonValidation) {
      const schema = JSON.parse(
        await readFile(resolve(root, url.replace(/^\.\//u, "")), "utf8"),
      ) as unknown;
      expect(schema).toMatchObject({
        $schema: "https://json-schema.org/draft/2020-12/schema",
      });
    }
  });

  it("uses strict JSON editing behavior for JSON-based systemd formats", async () => {
    const jsonLanguage = manifest.contributes.languages.find(
      (candidate) => candidate.id === "systemd-json",
    );
    expect(jsonLanguage?.configuration).toBe("./language-configuration-json.json");
    const configuration = JSON.parse(
      await readFile(resolve(root, "language-configuration-json.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(configuration).not.toHaveProperty("comments");

    for (const language of manifest.contributes.languages) {
      if (language.id !== "systemd-json") {
        expect(language.configuration).toBe("./language-configuration.json");
      }
    }
  });

  it("declaratively recognizes namespaced journal, kernel-install, hostname, and mkosi files", () => {
    const language = (id: string) =>
      manifest.contributes.languages.find((candidate) => candidate.id === id);
    expect(language("systemd-config")?.filenamePatterns).toEqual(
      expect.arrayContaining(["**/journald@*.conf", "**/journald@*.conf.d/*.conf"]),
    );
    expect(language("systemd-environment")?.filenames).toContain("hostname");
    expect(language("systemd-boot")?.filenames).toContain("install.conf");
    expect(language("systemd-config")?.filenames).not.toContain("install.conf");
    expect(language("mkosi")?.filenames).toContain("mkosi.initrd.conf");
    expect(language("mkosi")?.filenamePatterns).toEqual(
      expect.arrayContaining([
        "**/mkosi.presets/*",
        "**/mkosi.presets/**/*.conf",
        "**/mkosi.profiles/*",
        "**/mkosi.images/*",
        "**/mkosi.tools.conf/**/*.conf",
      ]),
    );
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
