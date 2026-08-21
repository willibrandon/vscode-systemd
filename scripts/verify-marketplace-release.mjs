import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { runInstalledDesktopSmoke } from "./run-installed-desktop-smoke.mjs";

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const extensionPublicFlag = 256;
const extensionValidatedFlag = 4;
const versionValidatedFlag = 1;

export function isExpectedMarketplaceRelease(metadata, expected) {
  if (typeof metadata !== "object" || metadata === null) return false;
  const publisher = metadata.publisher;
  if (typeof publisher !== "object" || publisher === null) return false;
  if (publisher.publisherName !== expected.publisher || metadata.extensionName !== expected.name) {
    return false;
  }
  if (
    !hasFlag(metadata.flags, extensionPublicFlag) ||
    !hasFlag(metadata.flags, extensionValidatedFlag)
  ) {
    return false;
  }
  if (!Array.isArray(metadata.versions)) return false;
  return metadata.versions.some((candidate) => {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      candidate.version !== expected.version
    ) {
      return false;
    }
    if (!hasFlag(candidate.flags, versionValidatedFlag)) return false;
    const properties = Array.isArray(candidate.properties) ? candidate.properties : [];
    const preRelease = properties.some(
      (property) =>
        typeof property === "object" &&
        property !== null &&
        property.key === "Microsoft.VisualStudio.Code.PreRelease" &&
        property.value === "true",
    );
    const sha256 = properties.find(
      (property) =>
        typeof property === "object" &&
        property !== null &&
        property.key === "Microsoft.VisualStudio.Services.VsixSha256",
    )?.value;
    return (
      preRelease === expected.preRelease &&
      typeof sha256 === "string" &&
      sha256.toLowerCase() === expected.sha256
    );
  });
}

function hasFlag(value, flag) {
  return typeof value === "number" && (value & flag) === flag;
}

export async function waitForMarketplaceRelease(options) {
  const { attempts, delay, expected, query } = options;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const metadata = await query();
      if (isExpectedMarketplaceRelease(metadata, expected)) return metadata;
      lastError = new Error(
        `Marketplace does not expose ${expected.publisher}.${expected.name}@${expected.version} yet.`,
      );
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts) await delay();
  }
  throw new Error(
    `Marketplace release verification failed after ${attempts} attempt${attempts === 1 ? "" : "s"}.`,
    { cause: lastError },
  );
}

export async function waitForMarketplaceInstallation(options) {
  const { attempts, delay, install } = options;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await install();
    } catch (error) {
      if (!isMarketplacePropagationError(error)) throw error;
      lastError = error;
    }
    if (attempt < attempts) await delay();
  }
  throw new Error(
    `Marketplace installation verification failed after ${attempts} attempt${attempts === 1 ? "" : "s"}.`,
    { cause: lastError },
  );
}

export function isMarketplacePropagationError(error) {
  if (typeof error !== "object" || error === null) return false;
  const message = "message" in error && typeof error.message === "string" ? error.message : "";
  const stderr = "stderr" in error && typeof error.stderr === "string" ? error.stderr : "";
  return /Extension '[^']+' not found\./u.test(`${message}\n${stderr}`);
}

async function queryMarketplace(extensionId) {
  const vsce = resolve(root, "node_modules/@vscode/vsce/vsce");
  const { stdout } = await execute(process.execPath, [vsce, "show", extensionId, "--json"], {
    cwd: root,
    maxBuffer: 1024 * 1024,
    timeout: 60_000,
  });
  const response = stdout.trim();
  return response === "" || response === "undefined" ? undefined : JSON.parse(response);
}

async function verifyMarketplaceRelease() {
  const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const minor = Number.parseInt(manifest.version.split(".")[1] ?? "", 10);
  if (!Number.isSafeInteger(minor)) throw new Error(`Invalid release version ${manifest.version}.`);
  const vsix = resolve(root, `dist/systemd-${manifest.version}.vsix`);
  const checksum = resolve(root, `dist/systemd-${manifest.version}.sha256`);
  const sha256 = createHash("sha256")
    .update(await readFile(vsix))
    .digest("hex");
  const recordedChecksum = await readFile(checksum, "utf8");
  if (recordedChecksum !== `${sha256}  systemd-${manifest.version}.vsix\n`) {
    throw new Error("The release checksum does not match the tested VSIX.");
  }
  const expected = {
    publisher: manifest.publisher,
    name: manifest.name,
    version: manifest.version,
    preRelease: minor % 2 === 1,
    sha256,
  };
  const extensionId = `${expected.publisher}.${expected.name}`;
  const attempts = positiveInteger(process.env.MARKETPLACE_VERIFY_ATTEMPTS, 40);
  const interval = positiveInteger(process.env.MARKETPLACE_VERIFY_INTERVAL_MS, 30_000);
  const delay = async () =>
    new Promise((resolvePromise) => globalThis.setTimeout(resolvePromise, interval));

  await waitForMarketplaceRelease({
    attempts,
    delay,
    expected,
    query: async () => queryMarketplace(extensionId),
  });

  const temporaryRoot = await mkdtemp(join(tmpdir(), "vscode-systemd-marketplace-"));
  const extensionsDirectory = resolve(temporaryRoot, "extensions");
  const userDataDirectory = resolve(temporaryRoot, "user-data");
  await Promise.all([mkdir(extensionsDirectory), mkdir(userDataDirectory)]);
  try {
    await waitForMarketplaceInstallation({
      attempts,
      delay,
      install: async () =>
        runInstalledDesktopSmoke({
          expectedIdentity: `${extensionId}@${expected.version}`,
          extensionsDirectory,
          installTarget: `${extensionId}@${expected.version}`,
          preRelease: expected.preRelease,
          root,
          userDataDirectory,
          version: "stable",
        }),
    });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
  console.log(
    `Verified Marketplace checksum, installation, and activation for ${extensionId}@${expected.version}.`,
  );
}

function positiveInteger(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, received ${JSON.stringify(value)}.`);
  }
  return parsed;
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  await verifyMarketplaceRelease();
}
