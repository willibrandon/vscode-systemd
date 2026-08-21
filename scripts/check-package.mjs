import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { listFiles, PackageManager } from "@vscode/vsce";

const root = resolve(import.meta.dirname, "..");
const expected = JSON.parse(
  await readFile(resolve(root, "scripts/package-files.json"), "utf8"),
).sort();
const actual = (
  await listFiles({ cwd: root, packageManager: PackageManager.Npm, packagedDependencies: [] })
).sort();
const failures = [];

if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  const missing = expected.filter((path) => !actual.includes(path));
  const unexpected = actual.filter((path) => !expected.includes(path));
  failures.push(
    `package allowlist mismatch; missing=${JSON.stringify(missing)} unexpected=${JSON.stringify(unexpected)}`,
  );
}

const forbiddenPath =
  /(?:^|\/)(?:node_modules|packages|src|test|tests|fixtures|coverage|\.git|\.vscode-test|\.cache)(?:\/|$)|\.(?:map|ts|tsx|node|dll|dylib|exe|pdb|so)$/iu;
const secretPatterns = [
  /-----BEGIN (?:EC |OPENSSH |PGP |RSA )?PRIVATE KEY-----/u,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/u,
  /\bnpm_[A-Za-z0-9]{20,}\b/u,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u,
];
const privatePath = /(?:\/home\/[^/\s]+|\/Users\/[^/\s]+|[A-Za-z]:\\Users\\[^\\\s]+)/u;
let totalBytes = 0;
for (const path of actual) {
  if (forbiddenPath.test(path)) failures.push(`forbidden package path: ${path}`);
  const absolutePath = resolve(root, path);
  const bytes = await readFile(absolutePath);
  totalBytes += bytes.byteLength;
  if (path.startsWith("dist/") && bytes.byteLength > 1_500_000) {
    failures.push(`bundle exceeds 1.5 MB: ${path} (${bytes.byteLength} bytes)`);
  }
  const content = bytes.toString("utf8");
  if (privatePath.test(content)) failures.push(`private build path found in ${path}`);
  for (const pattern of secretPatterns) {
    if (pattern.test(content)) failures.push(`possible secret ${pattern.source} found in ${path}`);
  }
}
if (totalBytes > 5 * 1024 * 1024) {
  failures.push(`uncompressed package exceeds 5 MiB (${totalBytes} bytes)`);
}

if (failures.length > 0) throw new Error(`Package policy failed:\n- ${failures.join("\n- ")}`);
console.log(`Package allowlist passed: ${actual.length} files, ${totalBytes} uncompressed bytes.`);
