import type {
  AssignmentNode,
  EffectiveConfiguration,
  EffectiveEntry,
  ParsedDocument,
  Reference,
  ReferenceGraph,
  ReferenceGraphEdge,
  SemanticModel,
  TextSpan,
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
const graphReferenceKinds = new Set<Reference["kind"]>(["unit", "quadlet", "mkosi"]);

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

export interface OrderingDependencyEdge {
  readonly from: string;
  readonly to: string;
  readonly directive: "After" | "Before";
  readonly sourceUri: string;
  readonly span: TextSpan;
}

export interface OrderingDependencyCycle {
  readonly nodes: readonly string[];
  readonly edges: readonly OrderingDependencyEdge[];
}

export function resolveConfigurationDocuments(
  uri: string,
  documents: readonly ParsedDocument[],
): ConfigurationResolution {
  const available = uniqueDocuments(documents);
  return resolveConfigurationDocumentsWithAliases(uri, available, buildAliasIndex(available));
}

function resolveConfigurationDocumentsWithAliases(
  uri: string,
  available: readonly ParsedDocument[],
  aliases: AliasIndex,
): ConfigurationResolution {
  const identity = configurationIdentity(uri);
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
  const canonicalIdentity = aliases.canonical(identity);
  const equivalentIdentities = aliases.equivalent(identity);
  const mainCandidates = available.filter((document) => {
    const parts = configurationParts(document.uri);
    return (
      !parts.dropIn &&
      isUnitName(parts.identity) &&
      !parts.workingCopy &&
      (equivalentIdentities.includes(parts.identity) ||
        equivalentIdentities.map(templateName).includes(parts.identity))
    );
  });
  let base =
    queryParts.workingCopy && !queryParts.dropIn
      ? query
      : selectMain(
          canonicalIdentity,
          mainCandidates.filter(
            (document) => configurationIdentity(document.uri) === canonicalIdentity,
          ),
        );
  base ??= selectMain(templateName(canonicalIdentity), mainCandidates);
  base ??= selectMain(identity, mainCandidates);
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

  const ownerOrder = [
    ...new Set(equivalentIdentities.flatMap((candidate) => dropInOwners(candidate))),
  ];
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

export function resolveUnitConfigurations(
  documents: readonly ParsedDocument[],
): readonly ConfigurationResolution[] {
  const available = uniqueDocuments(documents);
  const aliases = buildAliasIndex(available);
  const mainByIdentity = new Map<string, ParsedDocument[]>();
  const dropInsByOwner = new Map<string, ParsedDocument[]>();
  const identities = new Set<string>();
  for (const document of available) {
    const parts = configurationParts(document.uri);
    if (parts.dropIn && parts.dropInOwner !== undefined) {
      dropInsByOwner.set(parts.dropInOwner, [
        ...(dropInsByOwner.get(parts.dropInOwner) ?? []),
        document,
      ]);
      if (isUnitName(parts.identity)) identities.add(parts.identity);
    } else if (isUnitName(parts.identity)) {
      mainByIdentity.set(parts.identity, [...(mainByIdentity.get(parts.identity) ?? []), document]);
      if (!parts.workingCopy) identities.add(parts.identity);
    }
  }
  return [...identities].sort().map((identity) => {
    const equivalent = aliases.equivalent(identity);
    const candidates = [
      ...equivalent.flatMap((candidate) => mainByIdentity.get(candidate) ?? []),
      ...equivalent.flatMap((candidate) => mainByIdentity.get(templateName(candidate)) ?? []),
      ...equivalent.flatMap((candidate) =>
        dropInOwners(candidate).flatMap((owner) => dropInsByOwner.get(owner) ?? []),
      ),
    ];
    return resolveConfigurationDocumentsWithAliases(identity, uniqueDocuments(candidates), aliases);
  });
}

export function findOrderingDependencyCycles(
  documents: readonly ParsedDocument[],
): readonly OrderingDependencyCycle[] {
  const byUri = new Map(documents.map((document) => [document.uri, document]));
  const edges: OrderingDependencyEdge[] = [];
  for (const resolution of resolveUnitConfigurations(documents)) {
    const configuration = mergeConfigurations(resolution.documents);
    for (const entry of configuration.entries) {
      if (entry.name !== "After" && entry.name !== "Before") continue;
      const document = byUri.get(entry.sourceUri);
      if (document === undefined) continue;
      for (const reference of extractReferences(document)) {
        if (
          reference.kind !== "unit" ||
          reference.span.start < entry.span.start ||
          reference.span.end > entry.span.end ||
          reference.target.includes("%")
        ) {
          continue;
        }
        edges.push({
          from: entry.name === "After" ? reference.target : resolution.identity,
          to: entry.name === "After" ? resolution.identity : reference.target,
          directive: entry.name,
          sourceUri: entry.sourceUri,
          span: reference.span,
        });
      }
    }
  }
  return stronglyConnectedCycles(edges);
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

export function buildSemanticModel(document: ParsedDocument): SemanticModel {
  return {
    document,
    sections: document.nodes.filter((node) => node.kind === "section"),
    assignments: document.nodes.filter((node) => node.kind === "assignment"),
    records: document.nodes.filter((node) => node.kind === "record"),
    references: extractReferences(document),
  };
}

export function buildReferenceGraph(documents: readonly ParsedDocument[]): ReferenceGraph {
  const sourceUris = new Map<string, Set<string>>();
  const edges: ReferenceGraphEdge[] = [];
  for (const document of documents) {
    const source = configurationIdentity(document.uri);
    const sourceSet = sourceUris.get(source) ?? new Set<string>();
    sourceSet.add(document.uri);
    sourceUris.set(source, sourceSet);
    for (const reference of extractReferences(document)) {
      if (!graphReferenceKinds.has(reference.kind)) continue;
      if (!sourceUris.has(reference.target)) sourceUris.set(reference.target, new Set());
      edges.push({
        source,
        target: reference.target,
        kind: reference.kind,
        sourceUri: reference.sourceUri,
        span: reference.span,
      });
    }
  }
  return {
    nodes: [...sourceUris]
      .map(([identity, uris]) => ({ identity, sourceUris: [...uris].sort() }))
      .sort((left, right) => left.identity.localeCompare(right.identity)),
    edges: edges.sort(
      (left, right) =>
        left.source.localeCompare(right.source) ||
        left.target.localeCompare(right.target) ||
        left.sourceUri.localeCompare(right.sourceUri),
    ),
  };
}

export function mergeConfigurations(
  documentsInPrecedenceOrder: readonly ParsedDocument[],
): EffectiveConfiguration {
  const selected = new Map<string, EffectiveEntry[]>();
  const resetGroups = new Map<string, string>();
  for (const document of documentsInPrecedenceOrder) {
    for (const node of document.nodes) {
      if (node.kind !== "assignment" || node.section === null) continue;
      const key = node.section + "\0" + node.name;
      const assignmentMode = node.definition?.assignmentMode ?? "replace";
      const resetGroup = node.definition?.resetGroup;
      if (resetGroup !== undefined) resetGroups.set(key, resetGroup);
      if (node.value === "" && assignmentMode === "append-no-reset") continue;
      if (node.value === "" && assignmentMode === "first") continue;
      if (node.value === "" && assignmentMode === "append") {
        if (resetGroup === undefined) {
          selected.set(key, []);
        } else {
          for (const [selectedKey, selectedGroup] of resetGroups) {
            if (selectedGroup === resetGroup) selected.set(selectedKey, []);
          }
        }
        continue;
      }
      const entry: EffectiveEntry = {
        section: node.section,
        name: node.name,
        value: node.value,
        sourceUri: document.uri,
        sourceLine: node.line + 1,
        span: node.span,
      };
      if (assignmentMode === "replace") {
        selected.set(key, [entry]);
        continue;
      }
      if (assignmentMode === "first" && selected.has(key)) continue;
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
        "# " + entry.sourceUri + ":" + String(entry.sourceLine),
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

interface AliasIndex {
  canonical(identity: string): string;
  equivalent(identity: string): readonly string[];
}

function buildAliasIndex(documents: readonly ParsedDocument[]): AliasIndex {
  const mainByIdentity = new Map<string, ParsedDocument[]>();
  const identities = new Set<string>();
  for (const document of documents) {
    const parts = configurationParts(document.uri);
    if (parts.dropIn || parts.workingCopy || !isUnitName(parts.identity)) continue;
    mainByIdentity.set(parts.identity, [...(mainByIdentity.get(parts.identity) ?? []), document]);
    identities.add(parts.identity);
    if (document.canonicalUri !== undefined) {
      const target = configurationIdentity(document.canonicalUri);
      if (isUnitName(target)) identities.add(target);
    }
  }
  const canonicalByIdentity = new Map<string, string>();
  const resolveCanonical = (identity: string, visiting = new Set<string>()): string => {
    const cached = canonicalByIdentity.get(identity);
    if (cached !== undefined) return cached;
    if (visiting.has(identity)) return identity;
    const nextVisiting = new Set(visiting).add(identity);
    const selected = selectMain(identity, mainByIdentity.get(identity) ?? []);
    const target =
      selected?.canonicalUri === undefined
        ? identity
        : configurationIdentity(selected.canonicalUri);
    const canonical =
      target === identity || !isUnitName(target)
        ? identity
        : resolveCanonical(target, nextVisiting);
    canonicalByIdentity.set(identity, canonical);
    return canonical;
  };
  const byCanonical = new Map<string, Set<string>>();
  for (const identity of identities) {
    const canonical = resolveCanonical(identity);
    const group = byCanonical.get(canonical) ?? new Set<string>();
    group.add(identity);
    group.add(canonical);
    byCanonical.set(canonical, group);
  }
  return {
    canonical(identity): string {
      return resolveCanonical(identity);
    },
    equivalent(identity): readonly string[] {
      const canonical = resolveCanonical(identity);
      const related = [...(byCanonical.get(canonical) ?? [])].sort();
      return [identity, canonical, ...related].filter(
        (candidate, index, all) => all.indexOf(candidate) === index,
      );
    },
  };
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
    if (!owner.includes(".") && !unitTypes.has(owner)) {
      return { identity: name, dropIn: false, workingCopy };
    }
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

function stronglyConnectedCycles(
  edges: readonly OrderingDependencyEdge[],
): readonly OrderingDependencyCycle[] {
  const forward = new Map<string, Set<string>>();
  const reverse = new Map<string, Set<string>>();
  for (const edge of edges) {
    forward.set(edge.from, new Set([...(forward.get(edge.from) ?? []), edge.to]));
    forward.set(edge.to, forward.get(edge.to) ?? new Set());
    reverse.set(edge.to, new Set([...(reverse.get(edge.to) ?? []), edge.from]));
    reverse.set(edge.from, reverse.get(edge.from) ?? new Set());
  }
  const visited = new Set<string>();
  const order: string[] = [];
  for (const node of forward.keys()) {
    if (visited.has(node)) continue;
    const stack: { node: string; expanded: boolean }[] = [{ node, expanded: false }];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined) break;
      if (current.expanded) {
        order.push(current.node);
        continue;
      }
      if (visited.has(current.node)) continue;
      visited.add(current.node);
      stack.push({ node: current.node, expanded: true });
      for (const next of forward.get(current.node) ?? []) {
        if (!visited.has(next)) stack.push({ node: next, expanded: false });
      }
    }
  }
  const assigned = new Set<string>();
  const result: OrderingDependencyCycle[] = [];
  for (const node of order.reverse()) {
    if (assigned.has(node)) continue;
    const component: string[] = [];
    const stack = [node];
    assigned.add(node);
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined) break;
      component.push(current);
      for (const next of reverse.get(current) ?? []) {
        if (assigned.has(next)) continue;
        assigned.add(next);
        stack.push(next);
      }
    }
    const members = new Set(component);
    const cycleEdges = edges.filter((edge) => members.has(edge.from) && members.has(edge.to));
    if (component.length > 1 || cycleEdges.some((edge) => edge.from === edge.to)) {
      result.push({ nodes: component.sort(), edges: cycleEdges });
    }
  }
  return result.sort((left, right) => (left.nodes[0] ?? "").localeCompare(right.nodes[0] ?? ""));
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
