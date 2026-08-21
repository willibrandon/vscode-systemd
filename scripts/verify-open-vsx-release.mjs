import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const registryOrigin = "https://open-vsx.org";
const registryExtensionUrl = new URL("/api/willibrandon/systemd", registryOrigin);

export function isExpectedOpenVsxRelease(metadata, expected) {
  if (typeof metadata !== "object" || metadata === null) return false;
  if (
    metadata.namespace !== expected.publisher ||
    metadata.name !== expected.name ||
    metadata.version !== expected.version ||
    metadata.preRelease !== expected.preRelease ||
    metadata.targetPlatform !== "universal" ||
    metadata.downloadable !== true
  ) {
    return false;
  }
  const files = metadata.files;
  if (typeof files !== "object" || files === null || typeof files.sha256 !== "string") {
    return false;
  }
  try {
    return new URL(files.sha256).origin === registryOrigin;
  } catch {
    return false;
  }
}

export async function waitForOpenVsxRelease(options) {
  const { attempts, delay, expected, query, readSha256 } = options;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const metadata = await query();
      if (!isExpectedOpenVsxRelease(metadata, expected)) {
        throw new Error(
          `Open VSX does not expose ${expected.publisher}.${expected.name}@${expected.version} yet.`,
        );
      }
      const sha256 = (await readSha256(metadata)).trim().toLowerCase();
      if (sha256 !== expected.sha256) {
        throw new Error(
          `Open VSX reports SHA-256 ${JSON.stringify(sha256)}, expected ${expected.sha256}.`,
        );
      }
      return metadata;
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts) await delay();
  }
  throw new Error(
    `Open VSX release verification failed after ${attempts} attempt${attempts === 1 ? "" : "s"}.`,
    { cause: lastError },
  );
}

async function queryOpenVsxRelease() {
  const response = await fetch(registryExtensionUrl, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(60_000),
  });
  if (response.status === 404) return undefined;
  if (!response.ok) {
    throw new Error(`Open VSX metadata request failed with HTTP ${response.status}.`);
  }
  return response.json();
}

async function readOpenVsxSha256(metadata) {
  const sha256Url = new URL(metadata.files.sha256);
  if (sha256Url.origin !== registryOrigin) {
    throw new Error(`Open VSX returned an unexpected SHA-256 URL: ${sha256Url.href}`);
  }
  const response = await fetch(sha256Url, {
    headers: { accept: "text/plain" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(`Open VSX SHA-256 request failed with HTTP ${response.status}.`);
  }
  return response.text();
}

async function verifyOpenVsxRelease() {
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
  const attempts = positiveInteger(process.env.OPEN_VSX_VERIFY_ATTEMPTS, 40);
  const interval = positiveInteger(process.env.OPEN_VSX_VERIFY_INTERVAL_MS, 30_000);
  const delay = async () =>
    new Promise((resolvePromise) => globalThis.setTimeout(resolvePromise, interval));

  await waitForOpenVsxRelease({
    attempts,
    delay,
    expected,
    query: queryOpenVsxRelease,
    readSha256: readOpenVsxSha256,
  });
  console.log(
    `Verified Open VSX version, channel, and checksum for ${expected.publisher}.${expected.name}@${expected.version}.`,
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
  await verifyOpenVsxRelease();
}
