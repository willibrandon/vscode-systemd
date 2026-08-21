import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const approvedLicenses = new Set([
  "(BSD-2-Clause OR MIT OR Apache-2.0)",
  "(MIT AND Zlib)",
  "(MIT OR CC0-1.0)",
  "(MIT OR GPL-3.0-or-later)",
  "(MIT OR WTFPL)",
  "0BSD",
  "Apache-2.0",
  "Artistic-2.0",
  "BlueOak-1.0.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "CC-BY-3.0",
  "CC0-1.0",
  "EPL-2.0",
  "ISC",
  "MIT",
  "MPL-2.0",
  "Python-2.0",
  "SEE LICENSE IN LICENSE.txt",
  "WTFPL",
]);
const expectedRuntimePackages = new Set([
  "balanced-match@4.0.4",
  "brace-expansion@5.0.9",
  "jsonc-parser@3.3.1",
  "minimatch@10.2.6",
  "semver@7.8.5",
  "vscode-jsonrpc@9.0.1",
  "vscode-languageclient@10.1.0",
  "vscode-languageserver-protocol@3.18.2",
  "vscode-languageserver-textdocument@1.0.12",
  "vscode-languageserver-types@3.18.0",
  "vscode-languageserver@10.1.0",
  "vscode-uri@3.1.0",
]);
const mitSha256 = "f74f925ccd6fc2f4b9bdf7682f6927a64809c8668e8232997c541cc6f992787b";

const lock = JSON.parse(await readFile(resolve(root, "package-lock.json"), "utf8"));
const failures = [];
for (const [path, metadata] of Object.entries(lock.packages)) {
  if (path === "" || path.startsWith("packages/") || path.startsWith("node_modules/@systemd/")) {
    continue;
  }
  const license = metadata.license;
  if (typeof license !== "string") {
    failures.push(`${path} has no declared license`);
  } else if (!approvedLicenses.has(license)) {
    failures.push(`${path} introduced unreviewed license expression ${JSON.stringify(license)}`);
  }
}

const license = await readFile(resolve(root, "LICENSE"));
if (createHash("sha256").update(license).digest("hex") !== mitSha256) {
  failures.push("LICENSE is not the reviewed MIT text");
}

const notices = await readFile(resolve(root, "THIRD-PARTY-NOTICES.md"), "utf8");
const metafiles = JSON.parse(await readFile(resolve(root, "dist/metafile.json"), "utf8"));
const bundledNames = new Set();
for (const metafile of metafiles) {
  for (const input of Object.keys(metafile.inputs)) {
    const match = /node_modules\/(?:@[^/]+\/[^/]+|[^/]+)/u.exec(input);
    if (match !== null) bundledNames.add(match[0].slice("node_modules/".length));
  }
}
const bundledPackages = new Set(
  [...bundledNames].map((name) => {
    const entry = lock.packages[`node_modules/${name}`];
    if (entry?.version === undefined) {
      failures.push(`bundled dependency ${name} has no root lockfile entry`);
      return `${name}@unknown`;
    }
    return `${name}@${entry.version}`;
  }),
);
for (const packageId of expectedRuntimePackages) {
  if (!bundledPackages.has(packageId))
    failures.push(`expected runtime dependency missing: ${packageId}`);
  if (!notices.includes(packageId)) failures.push(`third-party notice missing: ${packageId}`);
}
for (const packageId of bundledPackages) {
  if (!expectedRuntimePackages.has(packageId)) {
    failures.push(`unreviewed runtime dependency entered a bundle: ${packageId}`);
  }
}

if (failures.length > 0) {
  throw new Error(`License policy failed:\n- ${failures.join("\n- ")}`);
}

console.log(
  `License policy passed for ${Object.keys(lock.packages).length - 1} lockfile entries and ${bundledPackages.size} bundled dependencies.`,
);
