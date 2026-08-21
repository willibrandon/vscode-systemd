import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { createVSIX } from "@vscode/vsce";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { prepareCycloneDxForAttestation } from "./release-sbom.mjs";

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const vsix = resolve(root, `dist/systemd-${manifest.version}.vsix`);
const sbom = resolve(root, `dist/systemd-${manifest.version}.cdx.json`);
const checksum = resolve(root, `dist/systemd-${manifest.version}.sha256`);
const minorVersion = Number.parseInt(manifest.version.split(".")[1] ?? "", 10);
if (!Number.isSafeInteger(minorVersion)) {
  throw new Error(`Extension version must be major.minor.patch, received ${manifest.version}.`);
}
const preRelease = minorVersion % 2 === 1;
const { stdout: sourceRevisionOutput } = await execute("git", ["rev-parse", "HEAD"], {
  cwd: root,
});
const sourceRevision = sourceRevisionOutput.trim();
if (!/^[0-9a-f]{40}$/u.test(sourceRevision)) {
  throw new Error(`Unable to determine the source revision, received ${sourceRevision}.`);
}

await Promise.all([
  rm(vsix, { force: true }),
  rm(sbom, { force: true }),
  rm(checksum, { force: true }),
]);
await createVSIX({
  cwd: root,
  packagePath: vsix,
  dependencies: false,
  githubBranch: sourceRevision,
  preRelease,
});
const npmCli = process.env.npm_execpath;
if (npmCli === undefined || npmCli.length === 0) {
  throw new Error("The release artifact build must run through npm.");
}
const { stdout: generatedSbomText } = await execute(
  process.execPath,
  [npmCli, "sbom", "--package-lock-only", "--omit", "dev", "--sbom-format", "cyclonedx"],
  { cwd: root, maxBuffer: 8 * 1024 * 1024 },
);
const generatedSbom = JSON.parse(generatedSbomText);
const attestableSbom = prepareCycloneDxForAttestation(
  generatedSbom,
  `${manifest.publisher}.${manifest.name}@${manifest.version}:${sourceRevision}`,
);
await writeFile(sbom, `${JSON.stringify(attestableSbom, null, 2)}\n`, "utf8");
const digest = createHash("sha256")
  .update(await readFile(vsix))
  .digest("hex");
await writeFile(checksum, `${digest}  ${basename(vsix)}\n`, "utf8");

const sbomText = await readFile(sbom, "utf8");
if (/(?:\/home\/[^/\s]+|\/Users\/[^/\s]+|[A-Za-z]:\\\\Users\\\\[^\\\s]+)/u.test(sbomText)) {
  throw new Error("The generated SBOM contains a private build path.");
}
console.log(
  `Created ${basename(vsix)}, ${basename(checksum)}, and ${basename(sbom)} (${preRelease ? "pre-release" : "stable"}).`,
);
