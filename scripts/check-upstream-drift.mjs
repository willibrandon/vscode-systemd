import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const lock = JSON.parse(await readFile(resolve(root, "data/upstream.lock.json"), "utf8"));
const registry = JSON.parse(
  await readFile(resolve(root, "packages/language-core/src/generated/registry.json"), "utf8"),
);
const sources = {
  systemd: resolve(root, process.env.SYSTEMD_SOURCE ?? "../systemd"),
  podman: resolve(root, process.env.PODMAN_SOURCE ?? "../podman"),
  mkosi: resolve(root, process.env.MKOSI_SOURCE ?? "../mkosi"),
};
const failures = [];

if (lock.schemaVersion !== 1 || lock.adapterVersion !== 11) {
  failures.push("the upstream lock schema or adapter version is unsupported");
}

for (const [name, directory] of Object.entries(sources)) {
  const expected = lock.sources?.[name];
  if (expected === undefined) {
    failures.push(`${name}: lock entry is missing`);
    continue;
  }
  try {
    await access(directory);
  } catch {
    failures.push(`${name}: source tree is missing at ${directory}`);
    continue;
  }
  const [revision, tree, stableRevision, stableTree, remote] = await Promise.all([
    git(directory, ["rev-parse", "HEAD"]),
    git(directory, ["rev-parse", "HEAD^{tree}"]),
    git(directory, ["rev-parse", expected.tag]),
    git(directory, ["rev-parse", expected.tag + "^{tree}"]),
    git(directory, ["remote", "get-url", "origin"]),
  ]);
  if (revision !== expected.previewRevision) {
    failures.push(
      `${name}: preview revision ${revision} does not match ${expected.previewRevision}`,
    );
  }
  if (tree !== expected.previewTree) {
    failures.push(`${name}: preview tree ${tree} does not match ${expected.previewTree}`);
  }
  if (stableRevision !== expected.revision) {
    failures.push(`${name}: stable revision ${stableRevision} does not match ${expected.revision}`);
  }
  if (stableTree !== expected.tree) {
    failures.push(`${name}: stable tree ${stableTree} does not match ${expected.tree}`);
  }
  if (normalizeRemote(remote) !== normalizeRemote(expected.repository)) {
    failures.push(`${name}: remote ${remote} does not match ${expected.repository}`);
  }
  if (registry.upstream?.[name] !== expected.previewRevision) {
    failures.push(
      `${name}: generated registry is pinned to ${registry.upstream?.[name] ?? "nothing"}`,
    );
  }
}

if (failures.length > 0) {
  throw new Error(`Pinned upstream verification failed:\n- ${failures.join("\n- ")}`);
}
console.log(
  `Pinned upstream sources verified: systemd ${lock.sources.systemd.tag}, Podman ${lock.sources.podman.tag}, mkosi ${lock.sources.mkosi.tag}.`,
);

async function git(directory, arguments_) {
  const { stdout } = await execute("git", ["-C", directory, ...arguments_]);
  return stdout.trim();
}

function normalizeRemote(value) {
  return value
    .trim()
    .replace(/^git@github\.com:/u, "https://github.com/")
    .replace(/\/$/u, "")
    .replace(/\.git$/u, "")
    .toLowerCase();
}
