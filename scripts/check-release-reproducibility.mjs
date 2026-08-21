import { execFile } from "node:child_process";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const artifacts = ["vsix", "sha256", "cdx.json"].map((extension) =>
  resolve(root, "dist", "systemd-" + manifest.version + "." + extension),
);
const first = await Promise.all(artifacts.map((path) => readFile(path)));
const npmCli = process.env.npm_execpath;
if (npmCli === undefined || npmCli.length === 0) {
  throw new Error("The reproducibility check must run through npm.");
}

await execute(process.execPath, [npmCli, "run", "package:artifacts"], {
  cwd: root,
  maxBuffer: 8 * 1024 * 1024,
});
const second = await Promise.all(artifacts.map((path) => readFile(path)));
const changed = artifacts
  .map((path, index) => ({ path, index }))
  .filter(({ index }) => !first[index]?.equals(second[index]));
if (changed.length > 0) {
  throw new Error(
    "Release artifact reproduction failed:\n" +
      changed
        .map(
          ({ path, index }) =>
            "- " +
            basename(path) +
            ": " +
            digest(first[index] ?? Buffer.alloc(0)) +
            " != " +
            digest(second[index] ?? Buffer.alloc(0)),
        )
        .join("\n"),
  );
}
console.log("Reproduced byte-identical VSIX, checksum, and CycloneDX SBOM artifacts.");

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}
