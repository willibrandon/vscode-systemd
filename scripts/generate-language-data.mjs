import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import process from "node:process";

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, "packages/language-core/src/generated/registry.json");
const stableDeltaOutput = resolve(root, "packages/language-core/src/generated/stable-delta.json");
const lockOutput = resolve(root, "data/upstream.lock.json");
const checking = process.argv.includes("--check");
const adapterVersion = 10;
const sources = {
  systemd: resolve(root, process.env.SYSTEMD_SOURCE ?? "../systemd"),
  podman: resolve(root, process.env.PODMAN_SOURCE ?? "../podman"),
  mkosi: resolve(root, process.env.MKOSI_SOURCE ?? "../mkosi"),
};

const appendParsers = new Set([
  "config_parse_address_families",
  "config_parse_bind_paths",
  "config_parse_bpf_foreign_program",
  "config_parse_capability_set",
  "config_parse_cgroup_nft_set",
  "config_parse_cgroup_socket_bind",
  "config_parse_colon_separated_paths",
  "config_parse_device_allow",
  "config_parse_delegate",
  "config_parse_disable_controllers",
  "config_parse_documentation",
  "config_parse_environ",
  "config_parse_exec",
  "config_parse_exec_coredump_filter",
  "config_parse_exec_directories",
  "config_parse_extension_images",
  "config_parse_import_credential",
  "config_parse_in_addr_prefixes",
  "config_parse_io_device_latency",
  "config_parse_io_device_weight",
  "config_parse_io_limit",
  "config_parse_ip_filter_bpf_progs",
  "config_parse_load_credential",
  "config_parse_log_extra_fields",
  "config_parse_log_filter_patterns",
  "config_parse_luo_sessions",
  "config_parse_managed_oom_rules",
  "config_parse_mount_images",
  "config_parse_namespace_flags",
  "config_parse_namespace_path_strv",
  "config_parse_open_file",
  "config_parse_pass_environ",
  "config_parse_path_spec",
  "config_parse_restrict_filesystems",
  "config_parse_restrict_network_interfaces",
  "config_parse_service_refresh_on_reload",
  "config_parse_set_credential",
  "config_parse_set_status",
  "config_parse_socket_listen",
  "config_parse_strv",
  "config_parse_syscall_archs",
  "config_parse_syscall_filter",
  "config_parse_syscall_log",
  "config_parse_temporary_filesystems",
  "config_parse_timer",
  "config_parse_unit_condition_path",
  "config_parse_unit_condition_string",
  "config_parse_unit_cpu_set",
  "config_parse_unit_env_file",
  "config_parse_unit_path_strv_printf",
  "config_parse_unit_strv_printf",
  "config_parse_unset_environ",
  "config_parse_user_group_strv_compat",
  "config_parse_xattr",
]);

const appendWithoutResetParsers = new Set([
  "config_parse_obsolete_unit_deps",
  "config_parse_unit_deps",
  "config_parse_unit_mounts_for",
  "config_parse_service_sockets",
]);

const unavailable = [];
for (const [name, source] of Object.entries(sources)) {
  try {
    await access(source);
  } catch {
    unavailable.push(name + ":" + source);
  }
}

if (unavailable.length > 0) {
  if (!checking) throw new Error("Missing upstream trees: " + unavailable.join(", "));
  const bundled = JSON.parse(await readFile(output, "utf8"));
  const stableDelta = JSON.parse(await readFile(stableDeltaOutput, "utf8"));
  const lock = JSON.parse(await readFile(lockOutput, "utf8"));
  if (!Array.isArray(bundled.directives) || bundled.directives.length < 100) {
    throw new Error("Bundled registry is missing or incomplete.");
  }
  if (!Array.isArray(bundled.hwdbProperties) || !Array.isArray(bundled.hwdbMatchPrefixes)) {
    throw new Error("Bundled hwdb language data is missing or incomplete.");
  }
  validateLock(lock, bundled.upstream, stableDelta.upstream);
  console.log(
    "Validated bundled registry with " +
      bundled.directives.length +
      " preview records and a stable delta.",
  );
  process.exit(0);
}

const availability = extractAvailability(sources);
let records = new Map();
const directives = await generateDirectives(sources);
const stableTags = {
  systemd: latestStableTag(sources.systemd, /^v\d+$/u),
  podman: latestStableTag(sources.podman, /^v\d+\.\d+\.\d+$/u),
  mkosi: latestStableTag(sources.mkosi, /^v\d+(?:\.\d+)*$/u),
};
const stableSources = await extractStableSources(sources, stableTags);
let stableDirectives;
let stableHwdbLanguage;
try {
  stableDirectives = await generateDirectives(stableSources.sources);
  stableHwdbLanguage = await extractHwdbLanguage(stableSources.sources.systemd);
} finally {
  await rm(stableSources.temporaryDirectory, { recursive: true, force: true });
}
const hwdbLanguage = await extractHwdbLanguage(sources.systemd);
const compactDirectives = compactQuadletAppendModes(directives);
const registry = {
  schemaVersion: 1,
  generatedAt: "1970-01-01T00:00:00.000Z",
  upstream: {
    systemd: revision(sources.systemd),
    podman: revision(sources.podman),
    mkosi: revision(sources.mkosi),
  },
  quadletExtensions: [
    ".artifact",
    ".build",
    ".container",
    ".image",
    ".kube",
    ".network",
    ".pod",
    ".volume",
  ],
  dynamicDirectivePatterns: [
    "^ID_NET_NAME_ALLOW_.+$",
    "^ID_NET_NAME_SLOT_.+$",
    "^ID_NET_NAME_PATH_.+$",
    "^ID_NET_NAME_ONBOARD_.+$",
  ],
  hwdbProperties: hwdbLanguage.properties.map(serializeHwdbProperty),
  hwdbMatchPrefixes: hwdbLanguage.matchPrefixes,
  quadletAppend: compactDirectives.appendIndexes,
  directives: compactDirectives.directives,
};
const serialized = JSON.stringify(registry, null, 2) + "\n";
const stableUpstream = {
  systemd: revision(sources.systemd, stableTags.systemd),
  podman: revision(sources.podman, stableTags.podman),
  mkosi: revision(sources.mkosi, stableTags.mkosi),
};
const stableDelta = createRegistryDelta(
  directives,
  stableDirectives,
  stableUpstream,
  stableHwdbLanguage,
);
const serializedStableDelta = JSON.stringify(stableDelta, null, 2) + "\n";
const upstreamLock = {
  schemaVersion: 1,
  adapterVersion,
  sources: {
    systemd: sourceMetadata(
      sources.systemd,
      "https://github.com/systemd/systemd.git",
      "LGPL-2.1-or-later",
      stableTags.systemd,
    ),
    podman: sourceMetadata(
      sources.podman,
      "https://github.com/podman-container-tools/podman.git",
      "Apache-2.0",
      stableTags.podman,
    ),
    mkosi: sourceMetadata(
      sources.mkosi,
      "https://github.com/systemd/mkosi.git",
      "LGPL-2.1-or-later",
      stableTags.mkosi,
    ),
  },
};
validateLock(upstreamLock, registry.upstream, stableUpstream);
const serializedLock = JSON.stringify(upstreamLock, null, 2) + "\n";

if (checking) {
  const current = await readFile(output, "utf8");
  if (current !== serialized) {
    throw new Error(
      "Generated registry is stale (" + digest(current) + " != " + digest(serialized) + ").",
    );
  }
  const currentStableDelta = await readFile(stableDeltaOutput, "utf8");
  if (currentStableDelta !== serializedStableDelta) {
    throw new Error(
      "Generated stable delta is stale (" +
        digest(currentStableDelta) +
        " != " +
        digest(serializedStableDelta) +
        ").",
    );
  }
  const currentLock = await readFile(lockOutput, "utf8");
  if (currentLock !== serializedLock) {
    throw new Error(
      "Upstream lock is stale (" + digest(currentLock) + " != " + digest(serializedLock) + ").",
    );
  }
  console.log(
    "Generated registries are current with " +
      stableDirectives.length +
      " stable and " +
      directives.length +
      " preview records.",
  );
} else {
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, serialized, "utf8");
  await writeFile(stableDeltaOutput, serializedStableDelta, "utf8");
  await mkdir(dirname(lockOutput), { recursive: true });
  await writeFile(lockOutput, serializedLock, "utf8");
  console.log(
    "Generated " +
      directives.length +
      " preview records and " +
      stableDirectives.length +
      " stable records at " +
      output +
      " and refreshed " +
      lockOutput +
      ".",
  );
}

function revision(source, ref = "HEAD") {
  return execFileSync("git", ["-C", source, "rev-parse", ref], {
    encoding: "utf8",
  }).trim();
}

function tree(source, ref = "HEAD") {
  return execFileSync("git", ["-C", source, "rev-parse", ref + "^{tree}"], {
    encoding: "utf8",
  }).trim();
}

function sourceMetadata(source, repository, license, stableTag) {
  return {
    repository,
    tag: stableTag,
    revision: revision(source, stableTag),
    tree: tree(source, stableTag),
    previewRevision: revision(source),
    previewTree: tree(source),
    license,
  };
}

function validateLock(lock, previewRevisions, stableRevisions) {
  if (
    lock.schemaVersion !== 1 ||
    lock.adapterVersion !== adapterVersion ||
    typeof lock.sources !== "object"
  ) {
    throw new Error("Upstream lock has an unsupported schema or adapter version.");
  }
  for (const name of Object.keys(sources)) {
    const source = lock.sources[name];
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
      throw new Error("Upstream lock entry is incomplete: " + name + ".");
    }
    if (
      source.revision !== stableRevisions[name] ||
      source.previewRevision !== previewRevisions[name]
    ) {
      throw new Error("Upstream lock revisions do not match the registries: " + name + ".");
    }
  }
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

async function generateDirectives(sourceTrees) {
  records = new Map();
  await extractSystemd(sourceTrees.systemd);
  await extractQuadlet(sourceTrees.podman);
  await extractMkosi(sourceTrees.mkosi);
  return [...records.values()].sort((left, right) =>
    directiveKey(left).localeCompare(directiveKey(right)),
  );
}

function latestStableTag(source, pattern) {
  const tag = releaseTags(source, pattern).at(-1);
  if (tag === undefined) throw new Error("No stable release tag found in " + source + ".");
  return tag;
}

async function extractStableSources(sourceTrees, tags) {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "vscode-systemd-registry-"));
  const extracted = {
    systemd: join(temporaryDirectory, "systemd"),
    podman: join(temporaryDirectory, "podman"),
    mkosi: join(temporaryDirectory, "mkosi"),
  };
  try {
    await Promise.all(Object.values(extracted).map((directory) => mkdir(directory)));
    extractSourceArchive(sourceTrees.systemd, tags.systemd, extracted.systemd, [
      "src",
      "man",
      "hwdb.d/parse_hwdb.py",
    ]);
    extractSourceArchive(sourceTrees.podman, tags.podman, extracted.podman, [
      "pkg/systemd/quadlet/quadlet.go",
      "docs/source/markdown/podman-systemd.unit.5.md",
    ]);
    extractSourceArchive(sourceTrees.mkosi, tags.mkosi, extracted.mkosi, ["mkosi"]);
    return { temporaryDirectory, sources: extracted };
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
}

function extractSourceArchive(source, ref, destination, paths) {
  const archive = execFileSync("git", ["-C", source, "archive", "--format=tar", ref, ...paths], {
    maxBuffer: 128 * 1024 * 1024,
  });
  execFileSync("tar", ["-xf", "-", "-C", destination], {
    input: archive,
    maxBuffer: 128 * 1024 * 1024,
  });
}

function createRegistryDelta(previewDirectives, stableDirectives, upstream, stableHwdbLanguage) {
  const preview = new Map(
    previewDirectives.map((directive) => [directiveKey(directive), directive]),
  );
  const stable = new Map(stableDirectives.map((directive) => [directiveKey(directive), directive]));
  const previewHwdb = new Map(hwdbLanguage.properties.map((property) => [property.name, property]));
  const stableHwdb = new Map(
    stableHwdbLanguage.properties.map((property) => [property.name, property]),
  );
  const hwdbMatchPrefixesChanged =
    JSON.stringify(hwdbLanguage.matchPrefixes) !== JSON.stringify(stableHwdbLanguage.matchPrefixes);
  return {
    schemaVersion: 1,
    generatedAt: "1970-01-01T00:00:00.000Z",
    upstream,
    hwdbPropertyRemove: [...previewHwdb.keys()].filter((name) => !stableHwdb.has(name)).sort(),
    hwdbProperties: [...stableHwdb.entries()]
      .filter(
        ([name, property]) => JSON.stringify(previewHwdb.get(name)) !== JSON.stringify(property),
      )
      .map(([, property]) => serializeHwdbProperty(property)),
    ...(hwdbMatchPrefixesChanged ? { hwdbMatchPrefixes: stableHwdbLanguage.matchPrefixes } : {}),
    remove: [...preview.keys()].filter((key) => !stable.has(key)).sort(),
    directives: [...stable.entries()]
      .filter(([key, directive]) => JSON.stringify(preview.get(key)) !== JSON.stringify(directive))
      .map(([, directive]) => directive),
  };
}

function compactQuadletAppendModes(directives) {
  const appendIndexes = [];
  return {
    appendIndexes,
    directives: directives.map((directive, index) => {
      if (directive.dialect !== "podman-quadlet" || directive.assignmentMode !== "append") {
        return directive;
      }
      appendIndexes.push(index);
      const compact = { ...directive };
      delete compact.assignmentMode;
      return compact;
    }),
  };
}

function serializeHwdbProperty(property) {
  return [
    property.name,
    property.valueKind,
    property.choices,
    ...(property.pattern === undefined ? [] : [property.pattern]),
  ];
}

async function extractHwdbLanguage(source) {
  const text = await readFile(resolve(source, "hwdb.d/parse_hwdb.py"), "utf8");
  const propertiesStart = text.indexOf("    props = (");
  const propertiesEnd = text.indexOf("    fixed_props =", propertiesStart);
  if (propertiesStart < 0 || propertiesEnd < 0) {
    throw new Error("Unable to locate the systemd hwdb property grammar.");
  }
  const assignment = text.slice(propertiesStart, propertiesEnd);
  const tupleStart = assignment.indexOf("(", assignment.indexOf("props ="));
  const tuple = pythonDelimited(assignment, tupleStart, "(", ")");
  const properties = pythonTopLevel(tuple.slice(1, -1))
    .map((entry) => hwdbProperty(entry))
    .filter((entry) => entry !== undefined);

  if (/Regex\(r'KEYBOARD_KEY_\[0-9a-f\]\+'\)/u.test(text)) {
    properties.push({
      name: "KEYBOARD_KEY_<scan code>",
      pattern: "^KEYBOARD_KEY_[0-9a-f]+$",
      valueKind: "keycode",
      choices: [],
    });
  }
  if (/Regex\(r'EVDEV_ABS_\[0-9a-f\]\{2\}'\)/u.test(text)) {
    properties.push({
      name: "EVDEV_ABS_<axis>",
      pattern: "^EVDEV_ABS_[0-9a-f]{2}$",
      valueKind: "evdev-axis",
      choices: [],
    });
  }

  const matchPrefixes = extractHwdbMatchPrefixes(text);
  if (properties.length < 50 || matchPrefixes.length < 20) {
    throw new Error("Extracted systemd hwdb language data is unexpectedly incomplete.");
  }
  return {
    properties: properties.sort((left, right) => left.name.localeCompare(right.name)),
    matchPrefixes,
  };
}

function hwdbProperty(entry) {
  const trimmed = entry.trim();
  if (!trimmed.startsWith("(") || !trimmed.endsWith(")")) return undefined;
  const parts = pythonTopLevel(trimmed.slice(1, -1));
  if (parts.length !== 2) return undefined;
  const name = /^'([A-Z][A-Z0-9_]*)'$/u.exec(parts[0]?.trim() ?? "")?.[1];
  if (name === undefined) return undefined;
  const expression = parts[1]?.trim() ?? "";
  let valueKind = "string";
  let choices = [];
  if (expression === "zero_one") {
    valueKind = "boolean";
    choices = ["0", "1"];
  } else if (expression === "id_input_setting") {
    valueKind = "input-flag";
    choices = ["", "0", "1"];
  } else if (expression === "INTEGER") {
    valueKind = "integer";
  } else if (expression === "xkb_setting") {
    valueKind = "xkb";
  } else if (expression.includes("dpi_setting")) {
    valueKind = "dpi";
  } else if (expression === "mount_matrix") {
    valueKind = "mount-matrix";
  } else if (expression.startsWith("Or(") || expression.startsWith("Literal(")) {
    valueKind = "enum";
    choices = [...expression.matchAll(/'([^']*)'/gu)].map((match) => match[1] ?? "");
  }
  return { name, valueKind, choices: [...new Set(choices)] };
}

function extractHwdbMatchPrefixes(text) {
  const typesStart = text.indexOf("TYPES = {");
  const typesEnd = text.indexOf("\n}\n", typesStart);
  const generalStart = text.indexOf("GENERAL_MATCHES = {");
  const generalEnd = text.indexOf("\n}\n", generalStart);
  if (typesStart < 0 || typesEnd < 0 || generalStart < 0 || generalEnd < 0) return [];
  const prefixes = [];
  const types = text.slice(typesStart, typesEnd);
  for (const entry of types.matchAll(/'([^']+)'\s*:\s*(\([\s\S]*?\)|'[^']+')\s*,/gu)) {
    const category = entry[1] ?? "";
    for (const connection of (entry[2] ?? "").matchAll(/'([^']+)'/gu)) {
      prefixes.push(category + ":" + (connection[1] ?? "") + ":");
    }
  }
  const general = text.slice(generalStart, generalEnd);
  for (const entry of general.matchAll(/'([^']+)'/gu)) prefixes.push((entry[1] ?? "") + ":");
  return [...new Set(prefixes)].sort();
}

function pythonDelimited(text, start, open, close) {
  let depth = 0;
  let quote;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index] ?? "";
    if (quote !== undefined) {
      if (character === quote && !escaped) quote = undefined;
      escaped = character === "\\" && !escaped;
      if (character !== "\\") escaped = false;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === open) depth += 1;
    if (character === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  throw new Error("Unterminated Python delimiter while extracting hwdb metadata.");
}

function pythonTopLevel(text) {
  const result = [];
  let start = 0;
  let depth = 0;
  let quote;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? "";
    if (quote !== undefined) {
      if (character === quote && !escaped) quote = undefined;
      escaped = character === "\\" && !escaped;
      if (character !== "\\") escaped = false;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if ("([{\u007b".includes(character)) depth += 1;
    if (")]\u007d".includes(character)) depth -= 1;
    if (character === "," && depth === 0) {
      if (text.slice(start, index).trim() !== "") result.push(text.slice(start, index));
      start = index + 1;
    }
  }
  if (text.slice(start).trim() !== "") result.push(text.slice(start));
  return result;
}

function directiveKey(directive) {
  return [directive.dialect, directive.section, directive.name].join("\0");
}

function add(candidate) {
  if (!/^[A-Za-z][A-Za-z0-9_:@{}.-]*$/u.test(candidate.name)) return;
  const section = candidate.section || "*";
  const key = [candidate.dialect, section, candidate.name].join("\0");
  const value = {
    dialect: candidate.dialect,
    section,
    name: candidate.name,
    valueKind: candidate.valueKind ?? "string",
    since: candidate.since ?? null,
    deprecated: candidate.deprecated ?? false,
    documentation: candidate.documentation,
    summary: candidate.summary ?? candidate.name + " in [" + section + "].",
    choices: candidate.choices ?? [],
  };
  if (candidate.documentKinds?.length > 0) {
    value.documentKinds = [...new Set(candidate.documentKinds)].sort();
  }
  if (candidate.assignmentMode !== undefined && candidate.assignmentMode !== "replace") {
    value.assignmentMode = candidate.assignmentMode;
  }
  if (candidate.mkosiScope !== undefined && candidate.mkosiScope !== "local") {
    value.mkosiScope = candidate.mkosiScope;
  }
  if (candidate.mkosiTarget !== undefined) value.mkosiTarget = candidate.mkosiTarget;
  if (candidate.resetGroup !== undefined) value.resetGroup = candidate.resetGroup;
  if (candidate.exclusiveChoices !== undefined && value.choices.length > 0) {
    value.exclusiveChoices = candidate.exclusiveChoices;
  }
  const existing = records.get(key);
  if (existing === undefined) {
    records.set(key, value);
    return;
  }
  const documentation = existing.documentation.includes("/systemd.directives.html#")
    ? value.documentation
    : existing.documentation;
  const useExistingChoices = existing.choices.length > 0;
  const merged = {
    ...existing,
    valueKind: value.valueKind === "string" ? existing.valueKind : value.valueKind,
    since: earliestVersion(existing.since, value.since),
    deprecated: existing.deprecated || value.deprecated,
    documentation,
    summary: documentation === value.documentation ? value.summary : existing.summary,
    choices: useExistingChoices ? existing.choices : value.choices,
  };
  const documentKinds = [
    ...new Set([...(existing.documentKinds ?? []), ...(value.documentKinds ?? [])]),
  ].sort();
  if (documentKinds.length > 0) merged.documentKinds = documentKinds;
  const exclusiveChoices = useExistingChoices ? existing.exclusiveChoices : value.exclusiveChoices;
  if (exclusiveChoices !== undefined) merged.exclusiveChoices = exclusiveChoices;
  if (merged.assignmentMode === undefined && value.assignmentMode !== undefined) {
    merged.assignmentMode = value.assignmentMode;
  }
  if (merged.mkosiScope === undefined && value.mkosiScope !== undefined) {
    merged.mkosiScope = value.mkosiScope;
  }
  if (merged.mkosiTarget === undefined && value.mkosiTarget !== undefined) {
    merged.mkosiTarget = value.mkosiTarget;
  }
  if (merged.resetGroup === undefined && value.resetGroup !== undefined) {
    merged.resetGroup = value.resetGroup;
  }
  records.set(key, merged);
}

function earliestVersion(left, right) {
  if (left === null) return right;
  if (right === null) return left;
  const leftNumber = Number.parseInt(left, 10);
  const rightNumber = Number.parseInt(right, 10);
  if (Number.isNaN(leftNumber) || Number.isNaN(rightNumber)) return left;
  return leftNumber <= rightNumber ? left : right;
}

async function extractSystemd(source) {
  const semantics = new Map();
  for (const file of (await walk(resolve(source, "src"))).filter((name) =>
    /gperf(?:\.in)?$/u.test(name),
  )) {
    const text = await readFile(file, "utf8");
    const sourceClassification = classifySystemdParserTable(file);
    const dialect = sourceClassification.dialect;
    for (const line of text.split(/\r?\n/u)) {
      const match =
        /^\s*([A-Za-z0-9_@{}:+-]+)\.([A-Za-z][A-Za-z0-9_:@{}+.-]*),\s*(config_parse_[A-Za-z0-9_]+)/u.exec(
          line,
        );
      if (match === null) continue;
      const assignmentMode = parserAssignmentMode(match[3] ?? "");
      const resetGroup = parserResetGroup(match[3] ?? "", match[2] ?? "");
      const parserSection = match[1]?.includes("{{") === true ? "*" : (match[1] ?? "*");
      rememberSemantics(
        semantics,
        dialect,
        match[2] ?? "",
        parserSection,
        assignmentMode,
        resetGroup,
      );
      add({
        dialect,
        section: parserSection,
        name: match[2],
        documentKinds: sourceClassification.documentKinds,
        valueKind: parserKind(match[3] ?? ""),
        assignmentMode,
        resetGroup,
        documentation:
          "https://www.freedesktop.org/software/systemd/man/latest/systemd.directives.html#" +
          encodeURIComponent(match[2] ?? "") +
          "=",
      });
    }
  }

  for (const file of (await walk(resolve(source, "man"))).filter(
    (name) => extname(name) === ".xml",
  )) {
    const text = await readFile(file, "utf8");
    const manual = basename(file);
    const dialect =
      /^systemd\.(?:unit|service|socket|timer|path|mount|automount|swap|target|device|slice|scope|exec|kill|resource-control)\.xml$/u.test(
        manual,
      )
        ? "systemd-unit"
        : /^systemd\.(?:network|netdev|link|dnssd|dns-delegate)\.xml$/u.test(manual)
          ? "systemd-network"
          : "systemd-config";
    const documentKinds = systemdManualDocumentKinds(manual);
    const defaultSection = manualDefaultSection(manual);
    let section = defaultSection;
    const tokens =
      /<title>([\s\S]*?)<\/title>|<varlistentry(?:\s[^>]*)?>([\s\S]*?)<\/varlistentry>/gu;
    for (const match of text.matchAll(tokens)) {
      if (match[1] !== undefined) {
        section = /^\s*\[([A-Za-z0-9_:.-]+)\]/u.exec(match[1])?.[1] ?? defaultSection;
        continue;
      }
      const block = match[2];
      if (block === undefined) continue;
      const names = new Set();
      for (const term of block.matchAll(/<term(?:\s[^>]*)?>([\s\S]*?)<\/term>/gu)) {
        for (const declaration of (term[1] ?? "").matchAll(
          /<varname>([A-Za-z][A-Za-z0-9_:@{}.-]*)=[\s\S]*?<\/varname>/gu,
        )) {
          if (declaration[1] !== undefined) names.add(declaration[1]);
        }
      }
      const choiceMetadata = systemdChoices(block);
      for (const name of names) {
        if (name === undefined) continue;
        const inherited = inheritedSemantics(semantics, dialect, name);
        const resolvedSection = section === "*" ? (inherited?.section ?? section) : section;
        add({
          dialect,
          section: resolvedSection,
          name,
          documentKinds,
          assignmentMode: inherited?.assignmentMode,
          resetGroup: inherited?.resetGroup,
          since: /xpointer="v(\d+)"/u.exec(block)?.[1] ?? null,
          choices: choiceMetadata.choices,
          exclusiveChoices:
            choiceMetadata.exclusive && isClosedSystemdChoice(dialect, resolvedSection, name),
          documentation:
            "https://www.freedesktop.org/software/systemd/man/latest/" +
            basename(file, ".xml") +
            ".html#" +
            encodeURIComponent(name) +
            "=",
        });
      }
    }
  }
  await applySystemdValueCatalogs(source);
}

async function applySystemdValueCatalogs(source) {
  const signalSource = await readFile(resolve(source, "src/basic/signal-util.c"), "utf8");
  const signals = [...signalSource.matchAll(/\[SIG[A-Z0-9]+\]\s*=\s*"([A-Z0-9]+)"/gu)].map(
    (match) => "SIG" + (match[1] ?? ""),
  );
  signals.push("SIGRTMIN", "SIGRTMAX");

  const capabilitySource = await readFile(
    resolve(source, "src/include/uapi/linux/capability.h"),
    "utf8",
  );
  const capabilities = [
    ...capabilitySource.matchAll(/^#define\s+(CAP_[A-Z0-9_]+)\s+\d+\s*$/gmu),
  ].map((match) => match[1] ?? "");

  const seccompSource = await readFile(resolve(source, "src/shared/seccomp-util.c"), "utf8");
  const syscallGroups = [...seccompSource.matchAll(/\.name\s*=\s*"(@[a-z0-9-]+)"/gu)].map(
    (match) => match[1] ?? "",
  );

  const execManual = await readFile(resolve(source, "man/systemd.exec.xml"), "utf8");
  const addressFamilies = [...new Set(execManual.match(/AF_[A-Z0-9_]+/gu) ?? [])].sort();

  applyValueCatalog(
    new Set([
      "KillSignal",
      "RestartKillSignal",
      "FinalKillSignal",
      "WatchdogSignal",
      "ReloadSignal",
    ]),
    signals,
    "string",
  );
  applyValueCatalog(
    new Set(["CapabilityBoundingSet", "AmbientCapabilities"]),
    capabilities,
    "list",
  );
  applyValueCatalog(new Set(["SystemCallFilter", "SystemCallLog"]), syscallGroups, "list");
  applyValueCatalog(new Set(["RestrictAddressFamilies"]), addressFamilies, "list");
}

function applyValueCatalog(names, values, valueKind) {
  const choices = [...new Set(values.filter((value) => value !== ""))];
  for (const [key, definition] of records) {
    if (!names.has(definition.name)) continue;
    records.set(key, {
      ...definition,
      valueKind,
      choices: [...new Set([...definition.choices, ...choices])],
    });
  }
}

function classifySystemdParserTable(file) {
  if (file.includes("/src/core/")) return { dialect: "systemd-unit" };
  if (file.endsWith("/src/network/networkd-network-gperf.gperf")) {
    return { dialect: "systemd-network", documentKinds: ["systemd-network:network"] };
  }
  if (file.endsWith("/src/network/netdev/netdev-gperf.gperf")) {
    return { dialect: "systemd-network", documentKinds: ["systemd-network:netdev"] };
  }
  if (file.endsWith("/src/udev/net/link-config-gperf.gperf")) {
    return { dialect: "systemd-network", documentKinds: ["systemd-network:link"] };
  }
  if (file.endsWith("/src/network/networkd-gperf.gperf")) {
    return { dialect: "systemd-config", documentKinds: ["systemd-config:networkd"] };
  }
  return { dialect: "systemd-config" };
}

function systemdManualDocumentKinds(manual) {
  const kind =
    {
      "systemd.network.xml": "systemd-network:network",
      "systemd.netdev.xml": "systemd-network:netdev",
      "systemd.link.xml": "systemd-network:link",
      "systemd.dnssd.xml": "systemd-network:dnssd",
      "systemd.dns-delegate.xml": "systemd-network:dns-delegate",
    }[manual] ?? undefined;
  return kind === undefined ? undefined : [kind];
}

function isClosedSystemdChoice(dialect, section, name) {
  return (
    (dialect === "systemd-unit" && section === "Service" && name === "Type") ||
    (dialect === "systemd-network" && section === "Link" && name === "ActivationPolicy") ||
    (dialect === "systemd-network" &&
      section === "Network" &&
      ["DHCP", "LinkLocalAddressing"].includes(name))
  );
}

function manualDefaultSection(manual) {
  if (manual === "systemd.unit.xml") return "Unit";
  const unitType =
    /^systemd\.(service|socket|timer|path|mount|automount|swap|slice|scope)\.xml$/u.exec(
      manual,
    )?.[1];
  return unitType === undefined ? "*" : unitType.slice(0, 1).toUpperCase() + unitType.slice(1);
}

function systemdChoices(block) {
  for (const match of block.matchAll(/<para(?:\s[^>]*)?>([\s\S]*?)<\/para>/gu)) {
    const paragraph = match[1] ?? "";
    const lead =
      /\b(?:(?:takes|accepts)(?:\s+one\s+of)?|(?:must\s+be|may\s+be|should\s+be)\s+one\s+of|one\s+of)\b/iu.exec(
        paragraph,
      );
    if (lead === null) continue;
    const period = paragraph.indexOf(".", lead.index);
    const colon = paragraph.indexOf(":", lead.index);
    const end = period >= 0 ? period : colon >= 0 ? colon : paragraph.length;
    const sentence = paragraph.slice(lead.index, end);
    const choices = [...sentence.matchAll(/<(literal|option)>([\s\S]*?)<\/\1>/gu)]
      .map((choice) => systemdChoiceToken(choice[2] ?? ""))
      .filter((choice) => /^[^\s<>&]+$/u.test(choice));
    if (/\b(?:a\s+)?boolean\b/iu.test(sentence)) choices.unshift("yes", "no");
    const unique = [...new Set(choices)];
    if (unique.length >= 2 && unique.length <= 32) {
      return {
        choices: unique,
        exclusive: !sentence.includes("<replaceable>") && !/\bany other\b/iu.test(sentence),
      };
    }
  }
  return { choices: [], exclusive: undefined };
}

function systemdChoiceToken(value) {
  let result = "";
  let cursor = 0;
  let replaceableDepth = 0;
  for (const tag of value.matchAll(/<\/?([A-Za-z][A-Za-z0-9_.:-]*)(?:\s[^<>]*)?>/gu)) {
    if (replaceableDepth === 0) result += value.slice(cursor, tag.index);
    const name = (tag[1] ?? "").toLowerCase();
    if (name === "replaceable") {
      if ((tag[0] ?? "").startsWith("</")) replaceableDepth = Math.max(0, replaceableDepth - 1);
      else replaceableDepth += 1;
    }
    cursor = (tag.index ?? cursor) + (tag[0]?.length ?? 0);
  }
  if (replaceableDepth === 0) result += value.slice(cursor);
  return result.trim();
}

function rememberSemantics(semantics, dialect, name, section, assignmentMode, resetGroup) {
  const key = dialect + "\0" + name;
  const current = semantics.get(key) ?? {
    sections: new Set(),
    assignmentModes: new Set(),
    resetGroups: new Set(),
  };
  current.sections.add(section);
  current.assignmentModes.add(assignmentMode);
  if (resetGroup !== undefined) current.resetGroups.add(resetGroup);
  semantics.set(key, current);
}

function inheritedSemantics(semantics, dialect, name) {
  const value = semantics.get(dialect + "\0" + name);
  if (value === undefined) return undefined;
  return {
    assignmentMode: value.assignmentModes.size === 1 ? [...value.assignmentModes][0] : undefined,
    resetGroup: value.resetGroups.size === 1 ? [...value.resetGroups][0] : undefined,
    section: value.sections.size === 1 ? [...value.sections][0] : undefined,
  };
}

function extractAvailability(sourceTrees) {
  const result = new Map();
  for (const tag of releaseTags(sourceTrees.podman, /^v\d+\.\d+\.\d+$/u).filter((tag) => {
    const [major = 0, minor = 0] = tag
      .slice(1)
      .split(".")
      .map((part) => Number.parseInt(part, 10));
    return major > 4 || (major === 4 && minor >= 4);
  })) {
    const text = sourceAt(sourceTrees.podman, tag, "pkg/systemd/quadlet/quadlet.go");
    if (text === undefined) continue;
    for (const { section, name } of quadletSettings(text)) {
      rememberAvailability(result, "podman-quadlet", section, name, tag.slice(1));
    }
  }
  for (const tag of releaseTags(sourceTrees.mkosi, /^v(?:1[6-9]|2\d)(?:\.\d+)*$/u)) {
    const text = sourceAt(sourceTrees.mkosi, tag, "mkosi/config.py");
    if (text === undefined) continue;
    for (const { section, name } of mkosiSettings(text)) {
      rememberAvailability(result, "mkosi", section, name, tag.slice(1));
    }
  }
  return result;
}

function releaseTags(source, pattern) {
  return execFileSync("git", ["-C", source, "tag", "--list", "--sort=v:refname"], {
    encoding: "utf8",
  })
    .split(/\r?\n/u)
    .filter((tag) => pattern.test(tag));
}

function sourceAt(source, revision, path) {
  try {
    return execFileSync("git", ["-C", source, "show", revision + ":" + path], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
}

function rememberAvailability(result, dialect, section, name, version) {
  const key = availabilityKey(dialect, section, name);
  if (!result.has(key)) result.set(key, version);
}

function availabilityKey(dialect, section, name) {
  return [dialect, section, name].join("\0");
}

async function extractQuadlet(source) {
  const text = await readFile(resolve(source, "pkg/systemd/quadlet/quadlet.go"), "utf8");
  const documentationText = await readFile(
    resolve(source, "docs/source/markdown/podman-systemd.unit.5.md"),
    "utf8",
  );
  const sourceMetadata = quadletSourceMetadata(text);
  const documentationMetadata = quadletDocumentationMetadata(documentationText);
  for (const { section, name } of quadletSettings(text)) {
    const source = mergeQuadletMetadata(
      sourceMetadata.get("*\0" + name),
      sourceMetadata.get(section + "\0" + name),
    );
    const documented = documentationMetadata.get(section + "\0" + name);
    const choices = [...new Set([...(documented?.choices ?? []), ...(source.choices ?? [])])];
    add({
      dialect: "podman-quadlet",
      section,
      name,
      since: availability.get(availabilityKey("podman-quadlet", section, name)) ?? "preview",
      valueKind: source.valueKind ?? quadletKind(name),
      assignmentMode:
        source.assignmentMode === "append" || documented?.repeatable === true
          ? "append"
          : undefined,
      choices,
      exclusiveChoices:
        choices.length === 0
          ? undefined
          : documented?.exclusiveChoices === true && source.openChoices !== true,
      documentation: "https://docs.podman.io/en/latest/markdown/podman-systemd.unit.5.html",
      summary:
        name +
        " in [" +
        section +
        "]." +
        (documented?.defaultValue === undefined
          ? ""
          : " Defaults to " + documented.defaultValue + "."),
    });
  }
}

function mergeQuadletMetadata(fallback, exact) {
  return {
    ...fallback,
    ...exact,
    choices: [...new Set([...(fallback?.choices ?? []), ...(exact?.choices ?? [])])],
  };
}

function quadletSourceMetadata(text) {
  const constants = goStringConstants(text);
  const result = new Map();
  const remember = (groupExpression, keyExpression, metadata) => {
    const name = goStringValue(keyExpression, constants);
    if (name === undefined) return;
    const section = goStringValue(groupExpression, constants) ?? "*";
    const key = section + "\0" + name;
    result.set(key, mergeQuadletMetadata(result.get(key), metadata));
  };

  for (const match of text.matchAll(
    /\.LookupBoolean(?:WithDefault)?\(\s*([^,\n]+),\s*([^,\n)]+)/gu,
  )) {
    remember(match[1] ?? "", match[2] ?? "", { valueKind: "boolean" });
  }
  for (const match of text.matchAll(/\.LookupUint32\(\s*([^,\n]+),\s*([^,\n)]+)/gu)) {
    remember(match[1] ?? "", match[2] ?? "", { valueKind: "number" });
  }
  for (const match of text.matchAll(/\.LookupAll(?:Strv)?\(\s*([^,\n]+),\s*([^,\n)]+)/gu)) {
    remember(match[1] ?? "", match[2] ?? "", { assignmentMode: "append" });
  }

  for (const map of text.matchAll(
    /^\s*([A-Za-z][A-Za-z0-9_]*)\s*:=\s*map\[string\]string\s*\{([\s\S]*?)^\s*\}/gmu,
  )) {
    const mapName = map[1] ?? "";
    const mapEnd = (map.index ?? 0) + map[0].length;
    const following = text.slice(mapEnd, mapEnd + 320);
    const call = new RegExp(
      "lookupAndAdd(Boolean|AllStrings|KeyVals)\\([^,]+,\\s*([^,]+),\\s*" + mapName + "\\b",
      "u",
    ).exec(following);
    if (call === null) continue;
    const metadata =
      call[1] === "Boolean" ? { valueKind: "boolean" } : { assignmentMode: "append" };
    for (const entry of (map[2] ?? "").matchAll(/^\s*([^:\s]+)\s*:/gmu)) {
      remember(call[2] ?? "", entry[1] ?? "", metadata);
    }
  }

  if (/strings\.EqualFold\(notify,\s*"healthy"\)/u.test(text)) {
    const key = "Container\0Notify";
    result.set(
      key,
      mergeQuadletMetadata(result.get(key), {
        valueKind: "string",
        choices: ["yes", "no", "healthy"],
        openChoices: true,
      }),
    );
  }
  return result;
}

function goStringConstants(text) {
  const constants = new Map();
  for (const match of text.matchAll(/^\s*([A-Za-z][A-Za-z0-9_]*)\s*=\s*"([^"]*)"/gmu)) {
    constants.set(match[1], match[2]);
  }
  return constants;
}

function goStringValue(expression, constants) {
  const value = expression.trim();
  const literal = /^"([^"]*)"$/u.exec(value)?.[1];
  return literal ?? constants.get(value);
}

function quadletDocumentationMetadata(text) {
  const result = new Map();
  let section;
  let current;
  const finish = () => {
    if (section === undefined || current === undefined) return;
    const body = current.lines.join("\n");
    const choices = quadletDocumentedChoices(body);
    const headingDefault = /defaults? to `([^`]+)`/iu.exec(current.heading)?.[1];
    const bodyDefault = /\bdefault(?: value)? (?:is|to) (?:`|\*\*)([^`*\n.]+)(?:`|\*\*)/iu.exec(
      body,
    )?.[1];
    result.set(section + "\0" + current.name, {
      choices: choices.values,
      exclusiveChoices: choices.exclusive,
      repeatable: /\b(?:can|may) be (?:listed|used|specified) multiple times\b/iu.test(body),
      defaultValue: headingDefault ?? bodyDefault,
    });
  };
  for (const line of text.split(/\r?\n/u)) {
    const nextSection = /^## .*\[([A-Za-z]+)\]\s*$/u.exec(line)?.[1];
    if (nextSection !== undefined) {
      finish();
      current = undefined;
      section = nextSection;
      continue;
    }
    const heading = /^### `([^`]+)=`(.*)$/u.exec(line);
    if (heading !== null) {
      finish();
      current = { name: heading[1] ?? "", heading: heading[2] ?? "", lines: [] };
      continue;
    }
    current?.lines.push(line);
  }
  finish();
  return result;
}

function quadletDocumentedChoices(body) {
  const values = [];
  let exclusive = false;
  const supported = /\bthe following values are supported\s*:/iu.exec(body);
  if (supported !== null) {
    exclusive = true;
    const tail = body.slice((supported.index ?? 0) + supported[0].length);
    for (const match of tail.matchAll(/^\s*[-*]\s+`([^`]+)`\s*:/gmu)) {
      const value = match[1] ?? "";
      const pattern = /^([^/]+)\/\(([^)]+)\)$/u.exec(value);
      if (pattern !== null) {
        exclusive = false;
        for (const choice of (pattern[2] ?? "").split("|")) {
          values.push((pattern[1] ?? "name") + "/" + choice);
        }
      } else if (/^[A-Za-z0-9_.+-]+$/u.test(value)) {
        values.push(value);
      } else {
        exclusive = false;
      }
    }
  }
  const currentlySupported = /\bCurrently ([^.]+) are supported\./iu.exec(body)?.[1];
  if (currentlySupported !== undefined) {
    values.push(...[...currentlySupported.matchAll(/`([^`]+)`/gu)].map((match) => match[1] ?? ""));
  }
  const specialKeys = /\bspecial keys? ([^.]+?) to (?:set|use|select|make)\b/iu.exec(body)?.[1];
  if (specialKeys !== undefined) {
    values.push(...[...specialKeys.matchAll(/`([^`]+)`/gu)].map((match) => match[1] ?? ""));
  }
  return { values: [...new Set(values.filter(Boolean))], exclusive };
}

function quadletSettings(text) {
  const result = new Map();
  const constants = goStringConstants(text);
  const start = text.indexOf("groupsInfo = map[string]GroupInfo{");
  const lines = text.slice(start).split(/\r?\n/u);
  let section;
  let inKeys = false;
  for (const line of lines) {
    const group = /^\s*([A-Za-z0-9_]+Group):\s*\{/u.exec(line)?.[1];
    if (group !== undefined && !inKeys) {
      section = constants.get(group) ?? group.replace(/Group$/u, "");
      continue;
    }
    if (line.includes("SupportedKeys: map[string]bool{")) {
      inKeys = true;
      continue;
    }
    if (!inKeys || section === undefined) continue;
    const key = /^\s*([A-Za-z0-9_]+):\s*true,/u.exec(line)?.[1];
    if (key !== undefined) {
      const name = constants.get(key);
      if (name !== undefined) result.set(section + "\0" + name, { section, name });
    } else if (/^\s*\},?\s*$/u.test(line)) {
      inKeys = false;
    }
  }
  const legacyLines = text.split(/\r?\n/u);
  for (let index = 0; index < legacyLines.length; index += 1) {
    const group = /^\s*supported([A-Za-z0-9]+)Keys\s*=\s*map\[string\]bool\s*\{/u.exec(
      legacyLines[index] ?? "",
    )?.[1];
    if (group === undefined) continue;
    const legacySection = constants.get(group + "Group") ?? group;
    for (index += 1; index < legacyLines.length; index += 1) {
      const line = legacyLines[index] ?? "";
      if (/^\s*\}/u.test(line)) break;
      const symbol = /^\s*([A-Za-z0-9_]+)\s*:\s*true,/u.exec(line)?.[1];
      const name = symbol === undefined ? undefined : constants.get(symbol);
      if (name !== undefined) {
        result.set(legacySection + "\0" + name, { section: legacySection, name });
      }
    }
  }
  return [...result.values()];
}

async function extractMkosi(source) {
  const text = await readFile(resolve(source, "mkosi/config.py"), "utf8");
  const enumChoices = await extractPythonStringEnums(resolve(source, "mkosi"));
  for (const setting of mkosiSettings(text, enumChoices)) {
    add({
      dialect: "mkosi",
      section: setting.section,
      name: setting.name,
      since: availability.get(availabilityKey("mkosi", setting.section, setting.name)) ?? "preview",
      valueKind: parserKind(setting.parser),
      documentation: "https://www.freedesktop.org/software/mkosi/man/mkosi.html",
      deprecated: setting.deprecated,
      summary:
        setting.summary ??
        (setting.help === undefined ? undefined : setting.help.replace(/\.$/u, "") + "."),
      choices: setting.choices,
      exclusiveChoices: setting.exclusiveChoices ?? setting.choices.length > 0,
      assignmentMode: setting.assignmentMode,
      mkosiScope: setting.mkosiScope,
      mkosiTarget: setting.mkosiTarget,
    });
  }
}

function mkosiSettings(text, enumChoices = new Map()) {
  const result = [];
  const matchSections = ["Match", "TriggerMatch", "Assert", "TriggerAssert"];
  let cursor = 0;
  while ((cursor = text.indexOf("ConfigSetting(", cursor)) >= 0) {
    const block = balancedCall(text, cursor + "ConfigSetting".length);
    cursor = block.end;
    const dest = /\bdest="([^"]+)"/u.exec(block.text)?.[1];
    const section = /\bsection="([^"]+)"/u.exec(block.text)?.[1];
    if (dest === undefined || section === undefined) continue;
    const explicit = /\bname="([^"]+)"/u.exec(block.text)?.[1];
    const name =
      explicit ??
      dest
        .split("_")
        .filter(Boolean)
        .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
        .join("");
    const parser = /\bparse=([A-Za-z0-9_]+)/u.exec(block.text)?.[1] ?? "";
    const scope = /\bscope=SettingScope\.([A-Za-z0-9_]+)/u.exec(block.text)?.[1] ?? "local";
    const help = /\bhelp="([^"]+)"/su.exec(block.text)?.[1];
    const choices = configChoices(block.text, enumChoices);
    const setting = {
      dest,
      section,
      name,
      parser,
      help,
      choices,
      assignmentMode: mkosiAssignmentMode(parser, block.text),
      mkosiScope: scope.replaceAll("_", "-"),
    };
    result.push(setting);
    if (/\bmatch\s*=/u.test(block.text)) {
      addMkosiMatchSettings(result, matchSections, setting);
    }
    const aliases = /\bcompat_names=\(([^)]*)\)/su.exec(block.text)?.[1] ?? "";
    for (const alias of aliases.matchAll(/"([^"]+)"/gu)) {
      const compatibilitySetting = {
        dest,
        section,
        name: alias[1],
        parser,
        deprecated: true,
        summary: "Compatibility alias for " + name + ".",
        choices,
        assignmentMode: setting.assignmentMode,
        mkosiScope: setting.mkosiScope,
      };
      result.push(compatibilitySetting);
      if (/\bmatch\s*=/u.test(block.text)) {
        addMkosiMatchSettings(result, matchSections, compatibilitySetting);
      }
    }
  }
  for (const match of text.matchAll(/\bMatch\(\s*name="([^"]+)"/gu)) {
    addMkosiMatchSettings(result, matchSections, {
      name: match[1],
      parser: "",
      choices: [],
    });
  }
  const byDestination = new Map(
    result
      .filter((setting) => !matchSections.includes(setting.section) && !setting.deprecated)
      .map((setting) => [setting.dest, setting]),
  );
  for (const setting of result) {
    if (matchSections.includes(setting.section)) continue;
    const prefix = setting.mkosiScope === "tools" ? "tools_tree_" : "initrd_";
    if (!setting.dest?.startsWith(prefix)) continue;
    const target = byDestination.get(setting.dest.slice(prefix.length));
    if (target !== undefined) {
      setting.mkosiTarget = { section: target.section, name: target.name };
    }
  }
  return result;
}

function addMkosiMatchSettings(result, sections, setting) {
  for (const section of sections) {
    result.push({
      ...setting,
      section,
      parser: "",
      summary: "Match or assert against " + setting.name + ".",
      exclusiveChoices: false,
      assignmentMode: "append-no-reset",
    });
  }
}

function mkosiAssignmentMode(parser, block) {
  if (parser === "config_parse_minimum_version") return "maximum";
  if (
    [
      "config_make_credential_parser",
      "config_make_dict_parser",
      "config_make_list_parser",
      "config_parse_artifact_output_list",
    ].includes(parser)
  ) {
    return /\breset=False\b/u.test(block) ? "append-no-reset" : "append";
  }
  return "replace";
}

async function extractPythonStringEnums(directory) {
  const result = new Map();
  const files = (await walk(directory)).filter((file) => extname(file) === ".py");
  for (const file of files) {
    const lines = (await readFile(file, "utf8")).split(/\r?\n/u);
    for (let index = 0; index < lines.length; index += 1) {
      const declaration = /^class\s+([A-Za-z_][A-Za-z0-9_]*)\([^)]*\bStrEnum\b[^)]*\):\s*$/u.exec(
        lines[index] ?? "",
      );
      if (declaration === null) continue;
      const members = new Map();
      for (index += 1; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        if (line !== "" && !line.startsWith(" ") && !line.startsWith("#")) {
          index -= 1;
          break;
        }
        const assignment = /^ {4}([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*(?:#.*)?$/u.exec(line);
        if (assignment === null) continue;
        const name = assignment[1] ?? "";
        const expression = assignment[2] ?? "";
        const literal = /^(?:"([^"]*)"|'([^']*)')$/u.exec(expression);
        const alias = /^([A-Za-z_][A-Za-z0-9_]*)$/u.exec(expression)?.[1];
        const value =
          expression === "enum.auto()"
            ? name.replaceAll("_", "-")
            : (literal?.[1] ??
              literal?.[2] ??
              (alias === undefined ? undefined : members.get(alias)));
        if (value !== undefined) members.set(name, value);
      }
      result.set(declaration[1] ?? "", [...new Set(members.values())]);
    }
  }
  return result;
}

function configChoices(block, enumChoices) {
  const values = [];
  const literals = /\bchoices\s*=\s*\(([^)]*)\)/su.exec(block)?.[1];
  if (literals !== undefined) {
    for (const match of literals.matchAll(/(?:"([^"]*)"|'([^']*)')/gu)) {
      values.push(match[1] ?? match[2] ?? "");
    }
  }
  const enumCall = /\bchoices\s*=\s*([A-Za-z_][A-Za-z0-9_]*)\.(choices|values)\(\)/u.exec(block);
  if (enumCall !== null) {
    values.push(...(enumChoices.get(enumCall[1] ?? "") ?? []));
    if (enumCall[2] === "choices") values.push("");
  }
  const enumList = /\bchoices\s*=\s*list\(([A-Za-z_][A-Za-z0-9_]*)\)/u.exec(block)?.[1];
  if (enumList !== undefined) values.push(...(enumChoices.get(enumList) ?? []));
  return [...new Set(values)];
}

function balancedCall(text, opening) {
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = opening; index < text.length; index += 1) {
    const character = text[index];
    if (quote !== "") {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
      if (depth === 0) {
        return { text: text.slice(opening + 1, index), end: index + 1 };
      }
    }
  }
  return { text: text.slice(opening + 1), end: text.length };
}

function parserKind(parser) {
  const normalized = parser.toLowerCase();
  if (normalized === "config_parse_memory_limit") return "size";
  if (normalized === "config_parse_dhcp" || normalized.endsWith("_address_family")) return "string";
  if (normalized.endsWith("_address_families")) return "list";
  if (/(?:^|_)(?:capability_set|syscall_filter|syscall_log)(?:_|$)/u.test(normalized)) {
    return "list";
  }
  if (/(?:^|_)signal(?:_|$)/u.test(normalized)) return "string";
  if (/(?:^|_)(?:bool|boolean|tristate)(?:_|$)/u.test(normalized)) return "boolean";
  if (/(?:^|_)(?:sec|time|timespan|calendar)(?:_|$)/u.test(normalized)) return "duration";
  if (/(?:^|_)(?:size|bytes|iec)(?:_|$)/u.test(normalized)) return "size";
  if (normalized !== "config_parse_mode" && /(?:^|_)mode(?:_|$)/u.test(normalized)) {
    return "string";
  }
  if (
    normalized === "config_parse_mode" ||
    /(?:^|_)(?:u?int(?:8|16|32|64)?|unsigned|percent|nice)(?:_|$)/u.test(normalized)
  ) {
    return "number";
  }
  if (/(?:^|_)(?:path|filename|directory|image)(?:_|$)/u.test(normalized)) return "path";
  if (/(?:^|_)(?:address|cidr|prefix|gateway|dns)(?:_|$)/u.test(normalized)) return "address";
  if (/(?:^|_)(?:strv|list|set|words)(?:_|$)/u.test(normalized)) return "list";
  if (/(?:^|_)(?:exec|command|argv)(?:_|$)/u.test(normalized)) return "command";
  return "string";
}

function parserAssignmentMode(parser) {
  if (appendParsers.has(parser)) return "append";
  if (appendWithoutResetParsers.has(parser)) return "append-no-reset";
  if (parser === "config_parse_trigger_unit") return "first";
  return "replace";
}

function parserResetGroup(parser, name) {
  if (parser === "config_parse_timer") return "timer-values";
  if (parser === "config_parse_socket_listen") return "socket-listeners";
  if (parser === "config_parse_path_spec") return "path-specs";
  if (
    parser === "config_parse_unit_condition_path" ||
    parser === "config_parse_unit_condition_string"
  ) {
    return name.startsWith("Assert") ? "unit-asserts" : "unit-conditions";
  }
  return undefined;
}

function quadletKind(name) {
  if (/^(?:DNS|Gateway|IP|IP6|IPRange|Subnet)$/u.test(name)) return "address";
  if (/(?:Path|File|Rootfs|Yaml|SeccompProfile)$/u.test(name)) return "path";
  if (
    /^(?:Copy|DisableDNS|EnvironmentHost|HttpProxy|IPv6|Internal|KubeDownForce|NoNewPrivileges|Quiet|ReadOnly|ReadOnlyTmpfs|RunInit|TLSVerify)$/u.test(
      name,
    )
  ) {
    return "boolean";
  }
  if (/(?:Timeout|Interval|Period|Delay)$/u.test(name)) return "duration";
  if (/(?:Memory|ShmSize|MaxLogSize)$/u.test(name)) return "size";
  return "string";
}

async function walk(directory) {
  const result = [];
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) result.push(path);
    }
  }
  return result;
}
