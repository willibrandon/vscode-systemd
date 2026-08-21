import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const registry = JSON.parse(
  await readFile(resolve(root, "packages/language-core/src/generated/registry.json"), "utf8"),
);
const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const failures = [];
const minimums = {
  "systemd-unit": 700,
  "systemd-network": 900,
  "systemd-config": 1000,
  "podman-quadlet": 200,
  mkosi: 175,
};
const counts = Object.fromEntries(Object.keys(minimums).map((dialect) => [dialect, 0]));
for (const directive of registry.directives ?? []) {
  if (directive.dialect in counts) counts[directive.dialect] += 1;
  if (typeof directive.name !== "string" || directive.name.length === 0) {
    failures.push("registry contains a directive without a name");
  }
  if (
    typeof directive.documentation !== "string" ||
    !directive.documentation.startsWith("https://")
  ) {
    failures.push("registry directive lacks an HTTPS documentation URL: " + directive.name);
  }
}
for (const [dialect, minimum] of Object.entries(minimums)) {
  if (counts[dialect] < minimum) {
    failures.push(
      dialect +
        " has " +
        String(counts[dialect]) +
        " directives; expected at least " +
        String(minimum),
    );
  }
}
const expectedQuadlet = [
  ".artifact",
  ".build",
  ".container",
  ".image",
  ".kube",
  ".network",
  ".pod",
  ".volume",
];
if (JSON.stringify(registry.quadletExtensions) !== JSON.stringify(expectedQuadlet)) {
  failures.push("Quadlet extension coverage is incomplete");
}
if (manifest.contributes.languages.length !== 18) {
  failures.push("manifest must contribute exactly 18 explicit configuration dialects");
}
for (const grammar of manifest.contributes.grammars) {
  try {
    await access(resolve(root, grammar.path));
  } catch {
    failures.push("missing grammar: " + grammar.path);
  }
}
for (const snippet of manifest.contributes.snippets) {
  try {
    await access(resolve(root, snippet.path));
  } catch {
    failures.push("missing snippets: " + snippet.path);
  }
}
for (const [name, revision] of Object.entries(registry.upstream ?? {})) {
  if (!/^[0-9a-f]{40}$/u.test(revision)) {
    failures.push(name + " does not have a pinned 40-character Git revision");
  }
}
if (failures.length > 0) {
  throw new Error("Language coverage failed:\n- " + failures.join("\n- "));
}
console.log(
  "Language coverage passed: " +
    String(registry.directives.length) +
    " directives across " +
    String(manifest.contributes.languages.length) +
    " dialects (" +
    Object.entries(counts)
      .map(([name, count]) => name + "=" + String(count))
      .join(", ") +
    ").",
);
