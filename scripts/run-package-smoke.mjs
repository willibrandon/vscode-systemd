import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { runTests as runWebTests } from "@vscode/test-web";
import yauzl from "yauzl";
import { runInstalledDesktopSmoke } from "./run-installed-desktop-smoke.mjs";

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const version = process.env.VSCODE_VERSION ?? "stable";
const vsix = resolve(root, process.env.VSIX_PATH ?? `dist/systemd-${manifest.version}.vsix`);
const checksum = resolve(root, `dist/systemd-${manifest.version}.sha256`);
const webTests = resolve(root, "dist/test/web/index.cjs");
const { stdout: sourceRevisionOutput } = await execute("git", ["rev-parse", "HEAD"], {
  cwd: root,
});
const sourceRevision = sourceRevisionOutput.trim();
if (!/^[0-9a-f]{40}$/u.test(sourceRevision)) {
  throw new Error(`Unable to determine the source revision, received ${sourceRevision}.`);
}
await requireFile(webTests);
const digest = createHash("sha256")
  .update(await readFile(vsix))
  .digest("hex");
const expectedChecksum = `${digest}  ${basename(vsix)}\n`;
if ((await readFile(checksum, "utf8")) !== expectedChecksum) {
  throw new Error(`Checksum does not match ${basename(vsix)}.`);
}
const vsixManifest = await readZipText(vsix, "extension.vsixmanifest");
const minorVersion = Number.parseInt(manifest.version.split(".")[1] ?? "", 10);
const expectedPreRelease = Number.isSafeInteger(minorVersion) && minorVersion % 2 === 1;
const packagedAsPreRelease =
  /<Property Id="Microsoft\.VisualStudio\.Code\.PreRelease" Value="true"\s*\/>/u.test(vsixManifest);
if (packagedAsPreRelease !== expectedPreRelease) {
  throw new Error(`${basename(vsix)} channel does not match the odd-minor prerelease policy.`);
}

const temporaryRoot = await mkdtemp(join(tmpdir(), "vscode-systemd-vsix-"));
const extensionsDirectory = resolve(temporaryRoot, "extensions");
const userDataDirectory = resolve(temporaryRoot, "user-data");
const browserExtensionDirectory = resolve(temporaryRoot, "browser-extension");
const packagedWebTests = resolve(browserExtensionDirectory, "test-harness/index.cjs");
await Promise.all([
  mkdir(extensionsDirectory),
  mkdir(userDataDirectory),
  mkdir(browserExtensionDirectory),
]);

try {
  const expectedIdentity = `${manifest.publisher}.${manifest.name}@${manifest.version}`;
  await runInstalledDesktopSmoke({
    expectedIdentity,
    extensionsDirectory,
    installTarget: vsix,
    root,
    userDataDirectory,
    version,
  });

  await extractPackagedExtension(vsix, browserExtensionDirectory);
  await requirePackagedMetadata(browserExtensionDirectory, manifest);
  await mkdir(dirname(packagedWebTests), { recursive: true });
  await writeFile(packagedWebTests, await readFile(webTests));
  await runWebTests({
    browserType: "chromium",
    extensionDevelopmentPath: browserExtensionDirectory,
    extensionTestsPath: packagedWebTests,
    folderPath: resolve(root, "test/integration/fixtures"),
    headless: true,
    quality: version === "insiders" ? "insiders" : "stable",
    testRunnerDataDir: resolve(root, ".vscode-test-web/runtime"),
  });
  console.log(
    `Installed and activated ${expectedIdentity} from the exact local VSIX in clean desktop and browser hosts.`,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function requireFile(path) {
  try {
    if (!(await stat(path)).isFile()) throw new Error(`${path} is not a file.`);
  } catch (error) {
    throw new Error(`Package smoke test bundle is missing: ${path}`, { cause: error });
  }
}

async function requirePackagedMetadata(extensionDirectory, expected) {
  const packaged = JSON.parse(await readFile(resolve(extensionDirectory, "package.json"), "utf8"));
  for (const key of ["name", "publisher", "version", "main", "browser"]) {
    if (packaged[key] !== expected[key]) {
      throw new Error(
        `Packaged ${key} is ${JSON.stringify(packaged[key])}, expected ${JSON.stringify(expected[key])}.`,
      );
    }
  }
  const readme = await readFile(resolve(extensionDirectory, "readme.md"), "utf8");
  if (!readme.includes("systemd") || !readme.includes("Quadlet")) {
    throw new Error("The packaged README is not the systemd extension documentation.");
  }
}

function extractPackagedExtension(path, destination) {
  return new Promise((resolvePromise, rejectPromise) => {
    yauzl.open(path, { lazyEntries: true }, (openError, archive) => {
      if (openError !== null || archive === undefined) {
        rejectPromise(openError ?? new Error(`Unable to open ${path}.`));
        return;
      }
      archive.once("error", rejectPromise);
      archive.once("end", resolvePromise);
      archive.on("entry", (entry) => {
        if (!entry.fileName.startsWith("extension/") || entry.fileName.endsWith("/")) {
          archive.readEntry();
          return;
        }
        const relativePath = entry.fileName.slice("extension/".length);
        const outputPath = resolve(destination, relativePath);
        if (
          relativePath === "" ||
          relativePath.includes("\\") ||
          relativePath.includes("\0") ||
          (!outputPath.startsWith(`${destination}${sep}`) && outputPath !== destination)
        ) {
          rejectPromise(new Error(`Unsafe VSIX entry: ${entry.fileName}`));
          archive.close();
          return;
        }
        archive.openReadStream(entry, (streamError, stream) => {
          if (streamError !== null || stream === undefined) {
            rejectPromise(streamError ?? new Error(`Unable to read ${entry.fileName}.`));
            return;
          }
          const chunks = [];
          stream.on("data", (chunk) => chunks.push(chunk));
          stream.once("error", rejectPromise);
          stream.once("end", () => {
            void mkdir(dirname(outputPath), { recursive: true })
              .then(async () => writeFile(outputPath, Buffer.concat(chunks)))
              .then(() => archive.readEntry(), rejectPromise);
          });
        });
      });
      archive.readEntry();
    });
  });
}

function readZipText(path, expectedEntry) {
  return new Promise((resolvePromise, rejectPromise) => {
    yauzl.open(path, { lazyEntries: true }, (openError, archive) => {
      if (openError !== null || archive === undefined) {
        rejectPromise(openError ?? new Error(`Unable to open ${path}.`));
        return;
      }
      let found = false;
      archive.once("error", rejectPromise);
      archive.once("end", () => {
        if (!found) rejectPromise(new Error(`${expectedEntry} is missing from ${path}.`));
      });
      archive.on("entry", (entry) => {
        if (entry.fileName !== expectedEntry) {
          archive.readEntry();
          return;
        }
        found = true;
        archive.openReadStream(entry, (streamError, stream) => {
          if (streamError !== null || stream === undefined) {
            rejectPromise(streamError ?? new Error(`Unable to read ${expectedEntry}.`));
            return;
          }
          const chunks = [];
          stream.on("data", (chunk) => chunks.push(chunk));
          stream.once("error", rejectPromise);
          stream.once("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
        });
      });
      archive.readEntry();
    });
  });
}
