import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const registry = JSON.parse(
  await readFile(resolve(root, "packages/language-core/src/generated/registry.json"), "utf8"),
);
const stableDelta = JSON.parse(
  await readFile(resolve(root, "packages/language-core/src/generated/stable-delta.json"), "utf8"),
);
const upstreamLock = JSON.parse(await readFile(resolve(root, "data/upstream.lock.json"), "utf8"));
const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const failures = [];
const minimums = {
  "systemd-unit": 500,
  "systemd-network": 900,
  "systemd-config": 700,
  "podman-quadlet": 200,
  mkosi: 175,
};
const counts = Object.fromEntries(Object.keys(minimums).map((dialect) => [dialect, 0]));
const quadletAppend = new Set(registry.quadletAppend ?? []);
for (const index of quadletAppend) {
  const definition = registry.directives?.[index];
  if (definition?.dialect !== "podman-quadlet") {
    failures.push("compact Quadlet append index is invalid: " + String(index));
  } else {
    definition.assignmentMode = "append";
  }
}
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
if (upstreamLock.schemaVersion !== 1 || upstreamLock.adapterVersion !== 10) {
  failures.push("upstream lock must use schema version 1 and adapter version 10");
}
if ((registry.hwdbProperties?.length ?? 0) < 80) {
  failures.push("generated hwdb property coverage is incomplete");
}
if ((registry.hwdbMatchPrefixes?.length ?? 0) < 40) {
  failures.push("generated hwdb match-prefix coverage is incomplete");
}
for (const name of ["systemd", "podman", "mkosi"]) {
  const source = upstreamLock.sources?.[name];
  if (
    typeof source !== "object" ||
    source === null ||
    !/^https:\/\/github\.com\/.+\.git$/u.test(source.repository) ||
    typeof source.tag !== "string" ||
    source.tag.length === 0 ||
    !/^[0-9a-f]{40}$/u.test(source.revision) ||
    !/^[0-9a-f]{40}$/u.test(source.tree) ||
    !/^[0-9a-f]{40}$/u.test(source.previewRevision) ||
    !/^[0-9a-f]{40}$/u.test(source.previewTree) ||
    typeof source.license !== "string" ||
    source.license.length === 0
  ) {
    failures.push("upstream lock entry is incomplete: " + name);
  } else if (
    source.previewRevision !== registry.upstream?.[name] ||
    source.revision !== stableDelta.upstream?.[name]
  ) {
    failures.push("upstream lock revisions differ from the generated channels: " + name);
  }
}
if (
  stableDelta.schemaVersion !== 1 ||
  !Array.isArray(stableDelta.remove) ||
  !Array.isArray(stableDelta.directives) ||
  !Array.isArray(stableDelta.hwdbPropertyRemove) ||
  !Array.isArray(stableDelta.hwdbProperties) ||
  (stableDelta.hwdbMatchPrefixes !== undefined && !Array.isArray(stableDelta.hwdbMatchPrefixes))
) {
  failures.push("stable registry delta is missing or invalid");
}
for (const [section, name, expected] of [
  ["Distribution", "Distribution", "fedora"],
  ["Output", "Format", "disk"],
]) {
  const definition = registry.directives.find(
    (directive) =>
      directive.dialect === "mkosi" && directive.section === section && directive.name === name,
  );
  if (!definition?.choices?.includes(expected)) {
    failures.push("mkosi enum choices are missing for [" + section + "] " + name + "=");
  }
}
for (const [section, name, expected] of [
  ["Container", "AutoUpdate", ["registry", "local"]],
  ["Kube", "ExitCodePropagation", ["all", "any", "none"]],
  ["Network", "Driver", ["bridge", "macvlan", "ipvlan"]],
]) {
  const definition = registry.directives.find(
    (directive) =>
      directive.dialect === "podman-quadlet" &&
      directive.section === section &&
      directive.name === name,
  );
  if (JSON.stringify(definition?.choices) !== JSON.stringify(expected)) {
    failures.push("Quadlet choices are incomplete for [" + section + "] " + name + "=");
  }
}
for (const [section, name, valueKind] of [
  ["Quadlet", "DefaultDependencies", "boolean"],
  ["Network", "NetworkDeleteOnStop", "boolean"],
  ["Build", "ForceRM", "boolean"],
  ["Volume", "User", "number"],
]) {
  const definition = registry.directives.find(
    (directive) =>
      directive.dialect === "podman-quadlet" &&
      directive.section === section &&
      directive.name === name,
  );
  if (definition?.valueKind !== valueKind) {
    failures.push("Quadlet parser type is wrong for [" + section + "] " + name + "=");
  }
}
for (const [section, name] of [
  ["Container", "Volume"],
  ["Kube", "AutoUpdate"],
  ["Build", "ImageTag"],
]) {
  const definition = registry.directives.find(
    (directive) =>
      directive.dialect === "podman-quadlet" &&
      directive.section === section &&
      directive.name === name,
  );
  if (definition?.assignmentMode !== "append") {
    failures.push("Quadlet repeat semantics are missing for [" + section + "] " + name + "=");
  }
}
for (const section of ["Match", "TriggerMatch", "Assert", "TriggerAssert"]) {
  for (const name of ["Distribution", "PathExists", "SystemdVersion", "Image"]) {
    const definition = registry.directives.find(
      (directive) =>
        directive.dialect === "mkosi" && directive.section === section && directive.name === name,
    );
    if (definition === undefined) {
      failures.push("mkosi conditional metadata is missing [" + section + "] " + name + "=");
    }
  }
}
for (const [dialect, section, name, choices] of [
  [
    "systemd-unit",
    "Service",
    "Type",
    ["simple", "exec", "forking", "oneshot", "dbus", "notify", "notify-reload", "idle"],
  ],
  [
    "systemd-network",
    "Link",
    "ActivationPolicy",
    ["up", "always-up", "manual", "always-down", "down", "bound"],
  ],
  ["systemd-network", "Network", "IPMasquerade", ["ipv4", "ipv6", "both", "no"]],
  ["systemd-network", "Network", "DHCP", ["yes", "no", "ipv4", "ipv6"]],
  ["systemd-network", "Network", "LinkLocalAddressing", ["yes", "no", "ipv4", "ipv6"]],
]) {
  const definition = registry.directives.find(
    (directive) =>
      directive.dialect === dialect && directive.section === section && directive.name === name,
  );
  if (JSON.stringify(definition?.choices) !== JSON.stringify(choices)) {
    failures.push("systemd enum choices are incomplete for [" + section + "] " + name + "=");
  }
}
for (const [name, required] of [
  ["KillSignal", ["SIGTERM", "SIGKILL", "SIGRTMIN"]],
  ["CapabilityBoundingSet", ["CAP_CHOWN", "CAP_SYS_ADMIN", "CAP_BPF"]],
  ["SystemCallFilter", ["@default", "@system-service", "@known"]],
  ["RestrictAddressFamilies", ["AF_INET", "AF_INET6", "AF_UNIX"]],
]) {
  const definition = registry.directives.find(
    (candidate) => candidate.dialect === "systemd-unit" && candidate.name === name,
  );
  for (const value of required) {
    if (!definition?.choices?.includes(value)) {
      failures.push("systemd value catalog for " + name + " is missing " + value);
    }
  }
}
for (const [dialect, section, name, exclusive] of [
  ["systemd-unit", "Service", "Type", true],
  ["systemd-network", "Link", "ActivationPolicy", true],
  ["systemd-network", "Network", "IPMasquerade", false],
]) {
  const definition = registry.directives.find(
    (directive) =>
      directive.dialect === dialect && directive.section === section && directive.name === name,
  );
  if ((definition?.exclusiveChoices === true) !== exclusive) {
    failures.push("systemd enum exclusivity is unsafe for [" + section + "] " + name + "=");
  }
}
if (
  registry.directives.some(
    (directive) =>
      directive.dialect === "systemd-unit" &&
      directive.section === "Install" &&
      directive.name === "ExecStart",
  )
) {
  failures.push("prose references must not be generated as [Install] ExecStart=");
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
