import type {
  AssignmentNode,
  EffectiveConfiguration,
  EffectiveEntry,
  ParsedDocument,
  Reference,
} from "./types.js";

const unitReferenceSettings = new Set([
  "After",
  "Before",
  "BindsTo",
  "Conflicts",
  "OnFailure",
  "OnSuccess",
  "PartOf",
  "PropagatesReloadTo",
  "PropagatesStopTo",
  "ReloadPropagatedFrom",
  "Requires",
  "Requisite",
  "Upholds",
  "Wants",
  "WantedBy",
  "RequiredBy",
  "Also",
  "Alias",
]);

const quadletReferenceSettings = new Set([
  "Artifact",
  "Build",
  "Image",
  "ImageVolume",
  "Network",
  "Pod",
  "Volume",
]);

const unitTypes = new Set([
  "service",
  "socket",
  "timer",
  "path",
  "mount",
  "automount",
  "swap",
  "target",
  "device",
  "slice",
  "scope",
]);
const workingCopySuffixes = [
  ".ignore",
  ".backup",
  ".template",
  ".tmpl",
  ".jinja",
  ".j2",
  ".erb",
  ".in",
];

export interface ConfigurationResolution {
  readonly identity: string;
  readonly documents: readonly ParsedDocument[];
  readonly baseUri?: string;
  readonly dropInUris: readonly string[];
  readonly masked: boolean;
}

export function resolveConfigurationDocuments(
  uri: string,
  documents: readonly ParsedDocument[],
): ConfigurationResolution {
  const identity = configurationIdentity(uri);
  const available = uniqueDocuments(documents);
  if (!isUnitName(identity)) {
    const related = available
      .filter((document) => relatedConfiguration(uri, document.uri))
      .sort((left, right) => compareUriPrecedence(left.uri, right.uri));
    return {
      identity,
      documents: related,
      ...(related[0] === undefined ? {} : { baseUri: related[0].uri }),
      dropInUris: related.slice(1).map((document) => document.uri),
      masked: false,
    };
  }

  const query = available.find((document) => document.uri === uri);
  const queryParts = configurationParts(uri);
  const mainCandidates = available.filter((document) => {
    const parts = configurationParts(document.uri);
    return (
      !parts.dropIn &&
      isUnitName(parts.identity) &&
      !parts.workingCopy &&
      (parts.identity === identity || parts.identity === templateName(identity))
    );
  });
  let base =
    queryParts.workingCopy && !queryParts.dropIn
      ? query
      : selectMain(
          identity,
          mainCandidates.filter((document) => configurationIdentity(document.uri) === identity),
        );
  base ??= selectMain(templateName(identity), mainCandidates);
  if (base?.source.trim() === "") {
    return {
      identity,
      documents: [base],
      baseUri: base.uri,
      dropInUris: [],
      masked: true,
    };
  }

  const ownerOrder = dropInOwners(identity);
  const selectedDropIns = new Map<
    string,
    { document: ParsedDocument; owner: number; queried: boolean }
  >();
  for (const document of available) {
    const parts = configurationParts(document.uri);
    if (!parts.dropIn || parts.dropInFile === undefined || parts.dropInOwner === undefined)
      continue;
    if (parts.workingCopy && document.uri !== uri) continue;
    const owner = ownerOrder.indexOf(parts.dropInOwner);
    if (owner < 0) continue;
    const candidate = { document, owner, queried: document.uri === uri };
    const existing = selectedDropIns.get(parts.dropInFile);
    if (existing === undefined || compareDropIn(candidate, existing) > 0) {
      selectedDropIns.set(parts.dropInFile, candidate);
    }
  }
  const dropIns = [...selectedDropIns.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, candidate]) => candidate.document);
  const resolved = [...(base === undefined ? [] : [base]), ...dropIns];
  return {
    identity,
    documents: resolved,
    ...(base === undefined ? {} : { baseUri: base.uri }),
    dropInUris: dropIns.map((document) => document.uri),
    masked: false,
  };
}

export function configurationIdentity(uri: string): string {
  return configurationParts(uri).identity;
}

export function relatedConfiguration(left: string, right: string): boolean {
  return configurationIdentity(left) === configurationIdentity(right);
}

export function extractReferences(document: ParsedDocument): readonly Reference[] {
  const result: Reference[] = [];
  for (const node of document.nodes) {
    if (node.kind !== "assignment" || node.value === "") continue;
    const kind = referenceKind(document, node);
    if (kind === undefined) continue;
    for (const value of splitValues(node.value, node.valueSpan.start)) {
      result.push({
        sourceUri: document.uri,
        target: value.target,
        kind,
        span: value.span,
      });
    }
  }
  return result;
}

export function mergeConfigurations(
  documentsInPrecedenceOrder: readonly ParsedDocument[],
): EffectiveConfiguration {
  const selected = new Map<string, EffectiveEntry[]>();
  for (const document of documentsInPrecedenceOrder) {
    for (const node of document.nodes) {
      if (node.kind !== "assignment" || node.section === null) continue;
      const key = node.section + "\0" + node.name;
      if (node.value === "") {
        selected.set(key, []);
        continue;
      }
      const entry: EffectiveEntry = {
        section: node.section,
        name: node.name,
        value: node.value,
        sourceUri: document.uri,
        span: node.span,
      };
      const existing = selected.get(key) ?? [];
      selected.set(key, [...existing, entry]);
    }
  }
  return {
    entries: [...selected.values()].flat(),
    sources: documentsInPrecedenceOrder.map((document) => document.uri),
  };
}

export function renderEffectiveConfiguration(configuration: EffectiveConfiguration): string {
  const sections = new Map<string, EffectiveEntry[]>();
  for (const entry of configuration.entries) {
    sections.set(entry.section, [...(sections.get(entry.section) ?? []), entry]);
  }
  const lines = [
    "# Effective configuration",
    "# Sources are listed in increasing precedence:",
    ...configuration.sources.map((source) => "# - " + source),
    "",
  ];
  for (const [section, entries] of sections) {
    lines.push("[" + section + "]");
    for (const entry of entries) {
      lines.push(
        "# " + entry.sourceUri + ":" + String(entry.span.start),
        entry.name + "=" + entry.value,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

interface ConfigurationParts {
  readonly identity: string;
  readonly dropIn: boolean;
  readonly dropInOwner?: string;
  readonly dropInFile?: string;
  readonly workingCopy: boolean;
}

function configurationParts(uri: string): ConfigurationParts {
  const normalized = normalizeUriPath(uri);
  const parts = normalized.split("/");
  const rawName = parts.at(-1) ?? "";
  const parent = parts.at(-2) ?? "";
  const name = stripWorkingCopySuffixes(rawName);
  const workingCopy = name !== rawName;
  if (parent.endsWith(".d") && name.endsWith(".conf")) {
    const owner = parent.slice(0, -2);
    return {
      identity: stripWorkingCopySuffixes(owner),
      dropIn: true,
      dropInOwner: owner,
      dropInFile: name,
      workingCopy,
    };
  }
  return { identity: name, dropIn: false, workingCopy };
}

function stripWorkingCopySuffixes(name: string): string {
  let result = name;
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of workingCopySuffixes) {
      if (!result.endsWith(suffix)) continue;
      result = result.slice(0, -suffix.length);
      changed = true;
    }
  }
  return result;
}

function isUnitName(name: string): boolean {
  const type = name.slice(name.lastIndexOf(".") + 1);
  return unitTypes.has(type);
}

function templateName(name: string): string {
  const at = name.indexOf("@");
  const dot = name.lastIndexOf(".");
  return at < 0 || dot < at ? name : name.slice(0, at + 1) + name.slice(dot);
}

function dropInOwners(name: string): readonly string[] {
  if (!isUnitName(name)) return [name];
  const result: string[] = [];
  expandDropInOwners(name, result);
  result.push(name.slice(name.lastIndexOf(".") + 1));
  return [...new Set(result)];
}

function expandDropInOwners(name: string, result: string[]): void {
  result.push(name);
  const dot = name.lastIndexOf(".");
  const suffix = name.slice(dot);
  const stem = name.slice(0, dot);
  const at = stem.indexOf("@");
  const prefix = at < 0 ? stem : stem.slice(0, at);
  const instance = at < 0 ? undefined : stem.slice(at + 1);
  if (instance !== undefined && instance !== "") {
    expandDropInOwners(prefix + "@" + suffix, result);
  }
  const dash = prefix.endsWith("-")
    ? prefix.slice(0, -1).lastIndexOf("-")
    : prefix.lastIndexOf("-");
  if (dash <= 0) return;
  const truncated =
    prefix.slice(0, dash + 1) +
    (instance === undefined || instance === "" ? "" : "@" + instance) +
    suffix;
  expandDropInOwners(truncated, result);
}

function selectMain(
  name: string,
  candidates: readonly ParsedDocument[],
): ParsedDocument | undefined {
  return candidates
    .filter((document) => configurationIdentity(document.uri) === name)
    .sort((left, right) => compareUriPrecedence(right.uri, left.uri))[0];
}

function compareDropIn(
  left: { readonly document: ParsedDocument; readonly owner: number; readonly queried: boolean },
  right: { readonly document: ParsedDocument; readonly owner: number; readonly queried: boolean },
): number {
  if (left.queried !== right.queried) return left.queried ? 1 : -1;
  const path = loadPathRank(left.document.uri) - loadPathRank(right.document.uri);
  if (path !== 0) return path;
  const owner = right.owner - left.owner;
  return owner !== 0 ? owner : left.document.uri.localeCompare(right.document.uri);
}

function compareUriPrecedence(left: string, right: string): number {
  const rank = loadPathRank(left) - loadPathRank(right);
  return rank !== 0 ? rank : left.localeCompare(right);
}

function loadPathRank(uri: string): number {
  const path = normalizeUriPath(uri);
  if (path.includes("/etc/systemd/") || path.includes("/.config/systemd/")) return 40;
  if (path.includes("/run/systemd/") || /\/run\/user\/[^/]+\/systemd\//u.test(path)) return 30;
  if (path.includes("/.local/share/systemd/")) return 25;
  if (path.includes("/usr/local/lib/systemd/")) return 20;
  if (path.includes("/usr/lib/systemd/") || path.includes("/lib/systemd/")) return 10;
  return 25;
}

function normalizeUriPath(uri: string): string {
  try {
    return decodeURIComponent(uri).replaceAll("\\", "/");
  } catch {
    return uri.replaceAll("\\", "/");
  }
}

function uniqueDocuments(documents: readonly ParsedDocument[]): readonly ParsedDocument[] {
  return [...new Map(documents.map((document) => [document.uri, document])).values()];
}

function referenceKind(
  document: ParsedDocument,
  node: AssignmentNode,
): Reference["kind"] | undefined {
  if (unitReferenceSettings.has(node.name)) return "unit";
  if (document.dialect === "podman-quadlet" && quadletReferenceSettings.has(node.name)) {
    return "quadlet";
  }
  if (document.dialect === "mkosi" && ["Include", "Profiles", "Dependencies"].includes(node.name)) {
    return "mkosi";
  }
  if (node.name === "Documentation") return "documentation";
  if (node.definition?.valueKind === "path" || /(?:File|Path|Directory|Image)$/u.test(node.name)) {
    return "path";
  }
  return undefined;
}

function splitValues(
  value: string,
  valueOffset: number,
): readonly {
  readonly target: string;
  readonly span: { readonly start: number; readonly end: number };
}[] {
  const result: { target: string; span: { start: number; end: number } }[] = [];
  for (const match of value.matchAll(/\S+/gu)) {
    const token = match[0];
    const tokenOffset = match.index;
    const prefixLength = /^[-+!:@]+/u.exec(token)?.[0].length ?? 0;
    const suffixLength = /[,;]$/u.exec(token)?.[0].length ?? 0;
    const target = token.slice(prefixLength, token.length - suffixLength);
    if (target === "") continue;
    const start = valueOffset + tokenOffset + prefixLength;
    result.push({ target, span: { start, end: start + target.length } });
  }
  return result;
}
