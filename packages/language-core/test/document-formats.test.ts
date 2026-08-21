import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { minimatch } from "minimatch";
import { describe, expect, it } from "vitest";
import { classifyDocument, detectDialect } from "../src/index.js";
import type { DialectId, DocumentKind } from "../src/index.js";

const root = resolve(import.meta.dirname, "../../..");

interface FormatEntry {
  readonly name: string;
  readonly uri: string;
  readonly language: DialectId;
  readonly kind: DocumentKind;
  readonly source: string;
}

interface FormatInventory {
  readonly schemaVersion: number;
  readonly languages: readonly DialectId[];
  readonly formats: readonly FormatEntry[];
}

interface LanguageContribution {
  readonly id: DialectId;
  readonly extensions?: readonly string[];
  readonly filenames?: readonly string[];
  readonly filenamePatterns?: readonly string[];
}

const inventory = JSON.parse(
  await readFile(resolve(root, "data/document-formats.json"), "utf8"),
) as unknown as FormatInventory;
const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8")) as unknown as {
  readonly contributes: { readonly languages: readonly LanguageContribution[] };
};

describe("authoring format inventory", () => {
  it("is explicit, unique, and synchronized with the manifest", () => {
    expect(inventory.schemaVersion).toBe(1);
    expect(new Set(inventory.languages).size).toBe(18);
    expect(manifest.contributes.languages.map(({ id }) => id)).toEqual(inventory.languages);
    expect(new Set(inventory.formats.map(({ name }) => name)).size).toBe(inventory.formats.length);
    expect(new Set(inventory.formats.map(({ uri }) => uri)).size).toBe(inventory.formats.length);
    for (const language of inventory.languages) {
      expect(
        inventory.formats.some((format) => format.language === language),
        language,
      ).toBe(true);
    }
  });

  it.each(inventory.formats)("detects and classifies $name", (format) => {
    expect(detectDialect(format.uri, format.source), format.name).toBe(format.language);
    expect(classifyDocument(format.uri, format.language), format.name).toBe(format.kind);
    expect(format.kind.endsWith(":unknown"), format.name).toBe(false);
  });

  it.each(inventory.formats)("declaratively associates $name", (format) => {
    const contribution = manifest.contributes.languages.find(({ id }) => id === format.language);
    expect(contribution, format.language).toBeDefined();
    expect(matchesContribution(format.uri, contribution), format.name).toBe(true);
  });
});

function matchesContribution(uri: string, contribution: LanguageContribution | undefined): boolean {
  if (contribution === undefined) return false;
  const path = new URL(uri).pathname;
  const name = path.slice(path.lastIndexOf("/") + 1);
  return (
    contribution.filenames?.includes(name) === true ||
    contribution.extensions?.some((extension) => name.endsWith(extension)) === true ||
    contribution.filenamePatterns?.some((pattern) => minimatch(path, pattern)) === true
  );
}
