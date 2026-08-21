import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const entries = [
  ["dist/extension.cjs", 1_500_000],
  ["dist/browser.js", 1_500_000],
  ["dist/nodeServer.cjs", 1_500_000],
  ["dist/browserServer.js", 1_500_000],
];

for (const [relativePath, budget] of entries) {
  const path = resolve(root, relativePath);
  const contents = await readFile(path);
  if (contents.byteLength > budget) {
    throw new Error(`${relativePath} is ${contents.byteLength} bytes; the budget is ${budget}.`);
  }

  const source = contents.toString("utf8");
  const unresolvedRelativeRequire = /require\s*\(\s*["']\.{1,2}\//u.exec(source);
  if (unresolvedRelativeRequire !== null) {
    throw new Error(
      `${relativePath} contains an unresolved relative CommonJS require near byte ${String(unresolvedRelativeRequire.index)}.`,
    );
  }
}

for (const relativePath of ["dist/browser.js", "dist/browserServer.js"]) {
  const source = await readFile(resolve(root, relativePath), "utf8");
  for (const forbidden of [
    "node:fs",
    "node:path",
    "node:child_process",
    'require("fs")',
    'require("path")',
  ]) {
    if (source.includes(forbidden)) {
      throw new Error(`${relativePath} contains forbidden browser dependency ${forbidden}.`);
    }
  }
}
