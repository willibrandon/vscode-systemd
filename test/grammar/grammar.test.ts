import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
interface LanguageContribution {
  readonly id: string;
  readonly extensions?: readonly string[];
}

interface PathContribution {
  readonly path: string;
}

interface Manifest {
  readonly contributes: {
    readonly languages: readonly LanguageContribution[];
    readonly grammars: readonly PathContribution[];
    readonly snippets: readonly PathContribution[];
  };
}

interface LanguageConfiguration {
  readonly comments: {
    readonly lineComment: { readonly comment: string; readonly noIndent: boolean };
  };
}

const manifest = JSON.parse(
  await readFile(resolve(root, "package.json"), "utf8"),
) as unknown as Manifest;

describe("language contributions", () => {
  it("contributes 18 distinct, narrowly scoped dialects", () => {
    const languages = manifest.contributes.languages;
    const ids = languages.map((language) => language.id);
    expect(ids).toHaveLength(18);
    expect(new Set(ids).size).toBe(18);
    expect(languages.flatMap((language) => language.extensions ?? [])).not.toContain(".conf");
  });

  it("covers every current Quadlet type", () => {
    const quadlet = manifest.contributes.languages.find(
      (language) => language.id === "podman-quadlet",
    );
    const serialized = JSON.stringify(quadlet);
    for (const extension of [
      "artifact",
      "build",
      "container",
      "image",
      "kube",
      "network",
      "pod",
      "volume",
    ]) {
      expect(serialized).toContain(extension);
    }
  });

  it("ships valid JSON for every grammar, snippet, and language configuration", async () => {
    const paths = [
      ...manifest.contributes.grammars.map((grammar) => grammar.path),
      ...manifest.contributes.snippets.map((snippet) => snippet.path),
      "./language-configuration.json",
    ];
    for (const path of new Set(paths)) {
      await expect(
        readFile(resolve(root, path), "utf8").then((text): unknown => JSON.parse(text)),
      ).resolves.toBeTypeOf("object");
    }
  });

  it("uses the current object form for line-comment configuration", async () => {
    const configuration = JSON.parse(
      await readFile(resolve(root, "language-configuration.json"), "utf8"),
    ) as unknown as LanguageConfiguration;
    expect(configuration.comments.lineComment).toEqual({ comment: "#", noIndent: false });
  });
});
