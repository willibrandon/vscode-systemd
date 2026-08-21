import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { analyze, parse, registryMetadata } from "../../packages/language-core/src/index.js";

const root = resolve(import.meta.dirname, "../..");

interface Snippet {
  readonly prefix: string;
  readonly description: string;
  readonly body: string | readonly string[];
}

interface SnippetCase {
  readonly name: string;
  readonly uri: string;
  readonly requiredSection?: string;
}

const unitCases: readonly SnippetCase[] = [
  { name: "Service unit", uri: "file:///workspace/example.service", requiredSection: "Service" },
  { name: "Socket unit", uri: "file:///workspace/example.socket", requiredSection: "Socket" },
  { name: "Timer unit", uri: "file:///workspace/example.timer", requiredSection: "Timer" },
  { name: "Path unit", uri: "file:///workspace/example.path", requiredSection: "Path" },
  { name: "Mount unit", uri: "file:///workspace/mnt-example.mount", requiredSection: "Mount" },
  {
    name: "Automount unit",
    uri: "file:///workspace/mnt-example.automount",
    requiredSection: "Automount",
  },
  { name: "Swap unit", uri: "file:///workspace/example.swap", requiredSection: "Swap" },
  { name: "Target unit", uri: "file:///workspace/example.target" },
  { name: "Device unit", uri: "file:///workspace/dev-example.device" },
  { name: "Slice unit", uri: "file:///workspace/example.slice", requiredSection: "Slice" },
  {
    name: "Unit drop-in",
    uri: "file:///workspace/example.service.d/override.conf",
    requiredSection: "Service",
  },
];

const quadletCases: readonly SnippetCase[] = registryMetadata.quadletExtensions.map((extension) => {
  const type = extension.replace(/^\./u, "");
  return {
    name: "Quadlet " + type,
    uri: "file:///workspace/example." + type,
    requiredSection: type.slice(0, 1).toUpperCase() + type.slice(1),
  };
});

const mkosiCases: readonly SnippetCase[] = [
  { name: "mkosi image", uri: "file:///workspace/mkosi.conf" },
  { name: "mkosi bootable disk", uri: "file:///workspace/mkosi.conf" },
  { name: "mkosi unified kernel image", uri: "file:///workspace/mkosi.conf" },
  { name: "mkosi directory image", uri: "file:///workspace/mkosi.conf" },
];

describe("shipped snippets", () => {
  it("covers every author-configurable unit type", async () => {
    const snippets = await readSnippets("snippets/systemd.json");
    expect(Object.keys(snippets)).toEqual(unitCases.map(({ name }) => name));
    // Scope units are programmatically created and cannot be configured through unit files.
    expect(snippets["Scope unit"]).toBeUndefined();
  });

  it("covers every Quadlet type in the generated stable registry", async () => {
    const snippets = await readSnippets("snippets/quadlet.json");
    expect(Object.keys(snippets)).toEqual(quadletCases.map(({ name }) => name));
  });

  it("offers focused mkosi starting points", async () => {
    const snippets = await readSnippets("snippets/mkosi.json");
    expect(Object.keys(snippets)).toEqual(mkosiCases.map(({ name }) => name));
  });

  it.each([
    ["snippets/systemd.json", "systemd-unit", unitCases],
    ["snippets/quadlet.json", "podman-quadlet", quadletCases],
    ["snippets/mkosi.json", "mkosi", mkosiCases],
  ] as const)(
    "expands and semantically validates every snippet in %s",
    async (path, dialect, cases) => {
      const snippets = await readSnippets(path);
      for (const snippetCase of cases) {
        const snippet = snippets[snippetCase.name];
        expect(snippet, snippetCase.name).toBeDefined();
        if (snippet === undefined) continue;
        const source = expandSnippet(snippet.body);
        const document = parse(source, dialect, snippetCase.uri);
        const diagnostics = analyze(document);
        expect(diagnostics, snippetCase.name).toEqual([]);
        expect(
          document.nodes
            .filter((node) => node.kind === "assignment")
            .every((node) => node.definition !== undefined),
          snippetCase.name,
        ).toBe(true);
        if (snippetCase.requiredSection !== undefined) {
          expect(
            document.nodes.some(
              (node) => node.kind === "section" && node.name === snippetCase.requiredSection,
            ),
            snippetCase.name,
          ).toBe(true);
        }
      }
    },
  );

  it("uses unique, documented completion prefixes", async () => {
    const collections = await Promise.all([
      readSnippets("snippets/systemd.json"),
      readSnippets("snippets/quadlet.json"),
      readSnippets("snippets/mkosi.json"),
    ]);
    const snippets = collections.flatMap((collection) => Object.values(collection));
    const prefixes = snippets.map(({ prefix }) => prefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
    expect(snippets.every(({ description }) => description.trim() !== "")).toBe(true);
  });
});

async function readSnippets(path: string): Promise<Readonly<Record<string, Snippet>>> {
  const value: unknown = JSON.parse(await readFile(resolve(root, path), "utf8"));
  if (!isRecord(value)) throw new TypeError(path + " must contain a JSON object.");
  const snippets: Record<string, Snippet> = {};
  for (const [name, snippet] of Object.entries(value)) {
    if (!isSnippet(snippet)) throw new TypeError(name + " is not a complete snippet.");
    snippets[name] = snippet;
  }
  return snippets;
}

function isSnippet(value: unknown): value is Snippet {
  if (!isRecord(value)) return false;
  return (
    typeof value["prefix"] === "string" &&
    typeof value["description"] === "string" &&
    (typeof value["body"] === "string" ||
      (Array.isArray(value["body"]) && value["body"].every((line) => typeof line === "string")))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expandSnippet(body: string | readonly string[]): string {
  return (typeof body === "string" ? body : body.join("\n"))
    .replace(
      /\$\{\d+\|([^}]*)\|\}/gu,
      (_placeholder, choices: string) => choices.split(",")[0] ?? "",
    )
    .replace(/\$\{\d+:([^}]*)\}/gu, "$1")
    .replace(/\$\d+/gu, "")
    .concat("\n");
}
