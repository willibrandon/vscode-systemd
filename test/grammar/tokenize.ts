import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createOnigScanner, createOnigString, loadWASM } from "vscode-oniguruma";
import { Registry } from "vscode-textmate";
import type { IGrammar, IRawGrammar, IRawTheme, IToken } from "vscode-textmate";

let initialized: Promise<void> | undefined;
const paths: Readonly<Record<string, string>> = {
  "source.systemd": "syntaxes/systemd.tmLanguage.json",
  "source.systemd.network": "syntaxes/systemd-network.tmLanguage.json",
  "source.systemd.config": "syntaxes/systemd-config.tmLanguage.json",
  "source.podman.quadlet": "syntaxes/quadlet.tmLanguage.json",
  "source.mkosi": "syntaxes/mkosi.tmLanguage.json",
  "source.systemd.udev": "syntaxes/udev-rules.tmLanguage.json",
  "source.systemd.hwdb": "syntaxes/hwdb.tmLanguage.json",
  "source.systemd.json": "syntaxes/systemd-json.tmLanguage.json",
  "source.systemd.records": "syntaxes/systemd-records.tmLanguage.json",
  "source.systemd.markdown": "syntaxes/systemd-markdown.tmLanguage.json",
};
const jsonGrammar: IRawGrammar = {
  scopeName: "source.json",
  repository: {
    $self: { include: "source.json" },
    $base: { include: "source.json" },
  },
  patterns: [
    { name: "string.quoted.double.json", match: '"[^"]*"' },
    { name: "constant.language.json", match: "\\b(?:true|false|null)\\b" },
    { name: "constant.numeric.json", match: "-?[0-9]+(?:\\.[0-9]+)?" },
  ],
};

export async function loadGrammar(scopeName: string): Promise<IGrammar> {
  const registry = await createRegistry();
  const grammar = await registry.loadGrammar(scopeName);
  if (grammar === null) throw new Error("Unable to load " + scopeName + ".");
  return grammar;
}

export async function themedTokenAt(
  scopeName: string,
  source: string,
  lineIndex: number,
  character: number,
  theme: IRawTheme,
): Promise<IToken & { readonly foreground: string }> {
  const registry = await createRegistry(theme);
  const grammar = await registry.loadGrammar(scopeName);
  if (grammar === null) throw new Error("Unable to load " + scopeName + ".");
  const token = tokenAt(grammar, source, lineIndex, character);
  let ruleStack = null;
  const lines = source.split(/\r\n|\n|\r/u);
  let metadata = 0;
  for (let index = 0; index <= lineIndex; index += 1) {
    const result = grammar.tokenizeLine2(lines[index] ?? "", ruleStack);
    ruleStack = result.ruleStack;
    if (index !== lineIndex) continue;
    for (let offset = 0; offset < result.tokens.length; offset += 2) {
      const start = result.tokens[offset] ?? 0;
      const end = result.tokens[offset + 2] ?? lines[index]?.length ?? 0;
      if (start <= character && character < end) metadata = result.tokens[offset + 1] ?? 0;
    }
  }
  const foregroundId = (metadata >>> 15) & 0x1ff;
  const foreground = registry.getColorMap()[foregroundId];
  if (foreground === undefined) throw new Error("The themed token has no foreground color.");
  return { ...token, foreground };
}

async function createRegistry(theme?: IRawTheme): Promise<Registry> {
  initialized ??= initializeOniguruma();
  await initialized;
  const root = resolve(import.meta.dirname, "../..");
  return new Registry({
    onigLib: Promise.resolve({ createOnigScanner, createOnigString }),
    ...(theme === undefined ? {} : { theme }),
    async loadGrammar(requested): Promise<IRawGrammar | null> {
      if (requested === "source.json") return jsonGrammar;
      const path = paths[requested];
      if (path === undefined) return null;
      return JSON.parse(await readFile(resolve(root, path), "utf8")) as IRawGrammar;
    },
  });
}

export function tokenAt(
  grammar: IGrammar,
  source: string,
  lineIndex: number,
  character: number,
): IToken {
  let ruleStack = null;
  const lines = source.split(/\r\n|\n|\r/u);
  for (let index = 0; index <= lineIndex; index += 1) {
    const result = grammar.tokenizeLine(lines[index] ?? "", ruleStack);
    ruleStack = result.ruleStack;
    if (index !== lineIndex) continue;
    const token = result.tokens.find(
      ({ startIndex, endIndex }) => startIndex <= character && character < endIndex,
    );
    if (token !== undefined) return token;
  }
  throw new Error("No token at " + String(lineIndex) + ":" + String(character) + ".");
}

async function initializeOniguruma(): Promise<void> {
  const wasmPath = resolve(
    import.meta.dirname,
    "../../node_modules/vscode-oniguruma/release/onig.wasm",
  );
  const wasm = await readFile(wasmPath);
  await loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
}
