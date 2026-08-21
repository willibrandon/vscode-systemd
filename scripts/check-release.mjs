import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const changelog = await readFile(resolve(root, "CHANGELOG.md"), "utf8");
const expectedTag = `v${manifest.version}`;
const actualTag = process.env.GITHUB_REF_NAME ?? "";
const expectedExtensionId = "willibrandon.systemd";
const failures = [];

if (actualTag !== expectedTag)
  failures.push(`tag ${JSON.stringify(actualTag)} must equal ${expectedTag}`);
if (
  !new RegExp(`^## \\[${escapeRegex(manifest.version)}\\] - \\d{4}-\\d{2}-\\d{2}$`, "mu").test(
    changelog,
  )
) {
  failures.push(`CHANGELOG.md must contain a dated ${manifest.version} release heading`);
}
const extensionId = `${manifest.publisher}.${manifest.name}`;
if (expectedExtensionId !== extensionId)
  failures.push(`extension ID must be ${expectedExtensionId}`);
const { stdout: status } = await execute("git", ["status", "--porcelain"], { cwd: root });
if (status !== "") failures.push("release checkout is not clean");
try {
  const { stdout: tag } = await execute("git", ["describe", "--exact-match", "--tags", "HEAD"], {
    cwd: root,
  });
  if (tag.trim() !== expectedTag)
    failures.push(`HEAD is tagged ${tag.trim()}, expected ${expectedTag}`);
} catch {
  failures.push("HEAD does not have an exact release tag");
}

if (failures.length > 0)
  throw new Error(`Release preconditions failed:\n- ${failures.join("\n- ")}`);
console.log(`Release preconditions passed for ${extensionId} ${manifest.version}.`);

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
