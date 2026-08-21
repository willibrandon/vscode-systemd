import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createOnigScanner, createOnigString, loadWASM } from "vscode-oniguruma";
import { Registry } from "vscode-textmate";
import type { IGrammar, IRawGrammar, IToken } from "vscode-textmate";

let initialized: Promise<void> | undefined;

export async function loadGrammar(scopeName: string): Promise<IGrammar> {
  initialized ??= initializeOniguruma();
  await initialized;
  const root = resolve(import.meta.dirname, "../..");
  const paths: Readonly<Record<string, string>> = {
    "source.systemd": "syntaxes/systemd.tmLanguage.json",
    "source.systemd.hwdb": "syntaxes/hwdb.tmLanguage.json",
    "source.mkosi": "syntaxes/mkosi.tmLanguage.json",
  };
  const registry = new Registry({
    onigLib: Promise.resolve({ createOnigScanner, createOnigString }),
    async loadGrammar(requested): Promise<IRawGrammar | null> {
      const path = paths[requested];
      if (path === undefined) return null;
      return JSON.parse(await readFile(resolve(root, path), "utf8")) as IRawGrammar;
    },
  });
  const grammar = await registry.loadGrammar(scopeName);
  if (grammar === null) throw new Error("Unable to load " + scopeName + ".");
  return grammar;
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
