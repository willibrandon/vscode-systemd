import { readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const outputDirectories = [
  "dist",
  "coverage",
  "packages/language-core/lib",
  "packages/language-server/lib",
  "packages/vscode-client/lib",
];

await Promise.all([
  ...outputDirectories.map((directory) => emptyDirectory(resolve(root, directory))),
  removeBuildInfoFiles(resolve(root, "node_modules/.cache")),
]);

async function emptyDirectory(directory) {
  let entries;
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }

  await Promise.all(
    entries.map((entry) => rm(resolve(directory, entry), { force: true, recursive: true })),
  );
}

async function removeBuildInfoFiles(directory) {
  let entries;
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }

  await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".tsbuildinfo"))
      .map((entry) => rm(resolve(directory, entry), { force: true })),
  );
}
