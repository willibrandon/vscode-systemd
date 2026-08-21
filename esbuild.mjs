import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = import.meta.dirname;
const production = !process.argv.includes("--development");
const common = {
  absWorkingDir: root,
  bundle: true,
  legalComments: "none",
  logLevel: "info",
  mainFields: ["module", "main"],
  metafile: true,
  minify: production,
  sourcemap: production ? false : "external",
  sourcesContent: false,
  target: "es2025",
};

await mkdir(resolve(root, "dist"), { recursive: true });

const builds = await Promise.all([
  build({
    ...common,
    entryPoints: ["packages/vscode-client/src/desktop.ts"],
    outfile: "dist/extension.cjs",
    format: "cjs",
    platform: "node",
    external: ["vscode"],
  }),
  build({
    ...common,
    entryPoints: ["packages/vscode-client/src/browser.ts"],
    outfile: "dist/browser.js",
    format: "cjs",
    platform: "browser",
    external: ["vscode"],
    define: { global: "globalThis" },
  }),
  build({
    ...common,
    entryPoints: ["packages/language-server/src/node.ts"],
    outfile: "dist/nodeServer.cjs",
    format: "cjs",
    platform: "node",
  }),
  build({
    ...common,
    entryPoints: ["packages/language-server/src/browser.ts"],
    outfile: "dist/browserServer.js",
    format: "iife",
    platform: "browser",
    define: { global: "globalThis" },
  }),
  build({
    ...common,
    entryPoints: ["test/web/index.ts"],
    outfile: "dist/test/web/index.cjs",
    format: "cjs",
    platform: "browser",
    external: ["vscode"],
  }),
]);

await writeFile(
  resolve(root, "dist/metafile.json"),
  `${JSON.stringify(
    builds.map(({ metafile }) => metafile),
    null,
    2,
  )}\n`,
  "utf8",
);
