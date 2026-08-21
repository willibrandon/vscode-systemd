import type {
  AssignmentNode,
  CoreDiagnostic,
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
  "StopPropagatedFrom",
  "Upholds",
  "Wants",
  "WantedBy",
  "RequiredBy",
  "UpheldBy",
  "Also",
  "Alias",
]);

const quadletUnitDependencySettings = new Set([
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
  "StopPropagatedFrom",
  "Upholds",
  "Wants",
]);
const quadletExtensions = [
  ".artifact",
  ".build",
  ".container",
  ".image",
  ".kube",
  ".network",
  ".pod",
  ".volume",
] as const;
const graphReferenceKinds = new Set<Reference["kind"]>([
  "unit",
  "quadlet",
  "mkosi",
  "mkosi-include",
  "mkosi-profile",
  "mkosi-image",
]);
const mkosiBuiltInIncludes = new Set(["mkosi-addon", "mkosi-initrd", "mkosi-tools", "mkosi-vm"]);

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
const quadletTypes = new Set([
  "artifact",
  "build",
  "container",
  "image",
  "kube",
  "network",
  "pod",
  "volume",
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
  if (!isDropInAwareName(identity)) {
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
      isDropInAwareName(parts.identity) &&
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
    if (document.dialect === "podman-quadlet") {
      const quadlet = extractQuadletReferences(document, node);
      if (quadlet !== undefined) {
        result.push(...quadlet);
        continue;
      }
    }
    if (document.dialect === "mkosi") {
      const mkosi = extractMkosiReferences(document, node);
      if (mkosi !== undefined) {
        result.push(...mkosi);
        continue;
      }
    }
    const kind = referenceKind(node);
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

export function quadletReferenceExtensionsFor(
  kind: ParsedDocument["kind"],
  section: string | null,
  name: string,
): readonly string[] {
  if (section === "Unit" && quadletUnitDependencySettings.has(name)) return quadletExtensions;
  if (
    name === "Image" &&
    (kind === "podman-quadlet:container" || kind === "podman-quadlet:volume")
  ) {
    return [".build", ".image"];
  }
  if (
    name === "Network" &&
    [
      "podman-quadlet:container",
      "podman-quadlet:build",
      "podman-quadlet:kube",
      "podman-quadlet:pod",
    ].includes(kind)
  ) {
    return [".network", ".container"];
  }
  if (name === "Pod" && kind === "podman-quadlet:container") return [".pod"];
  if (
    name === "Volume" &&
    ["podman-quadlet:container", "podman-quadlet:build", "podman-quadlet:pod"].includes(kind)
  ) {
    return [".volume", ".artifact"];
  }
  if (name === "Mount" && kind === "podman-quadlet:container") {
    return [".volume", ".image", ".artifact"];
  }
  return [];
}

export function mkosiReferenceKindFor(
  section: string | null,
  name: string,
): Reference["kind"] | undefined {
  if (section === "Include" && name === "Include") return "mkosi-include";
  if (section === "Config" && name === "Profiles") return "mkosi-profile";
  if (section === "Config" && name === "Dependencies") return "mkosi-image";
  if (section === "Content" && name === "UnifiedKernelImageProfiles") {
    return "mkosi-uki-profile";
  }
  return undefined;
}

export function mkosiProfileName(uri: string): string | undefined {
  return mkosiCollectionName(uri, "mkosi.profiles");
}

export function mkosiImageName(uri: string): string | undefined {
  return mkosiCollectionName(uri, "mkosi.images");
}

export function mkosiReferenceKey(document: ParsedDocument, reference: Reference): string {
  const location = uriLocation(document.uri);
  switch (reference.kind) {
    case "mkosi-profile":
      return (
        "profile:" +
        location.origin +
        normalizeAbsolutePath(mkosiProfilesDirectory(location.path) + "/" + reference.target)
      );
    case "mkosi-image":
      return (
        "image:" +
        location.origin +
        normalizeAbsolutePath(mkosiImagesDirectory(location.path) + "/" + reference.target)
      );
    case "mkosi-include":
      return mkosiBuiltInIncludes.has(reference.target)
        ? "builtin:" + reference.target
        : "include:" + (resolvedMkosiPath(document.uri, reference.target) ?? reference.target);
    case "mkosi-uki-profile":
      return (
        "uki-profile:" + (resolvedMkosiPath(document.uri, reference.target) ?? reference.target)
      );
    default:
      return reference.kind + ":" + reference.target;
  }
}

export function resolveMkosiReferenceDocuments(
  document: ParsedDocument,
  reference: Reference,
  documents: readonly ParsedDocument[],
): readonly ParsedDocument[] {
  const candidates = documents.filter(({ dialect }) => dialect === "mkosi");
  switch (reference.kind) {
    case "mkosi-profile":
      return preferredMkosiEntry(
        document.uri,
        candidates.filter(({ uri }) => mkosiProfileName(uri) === reference.target),
        "mkosi.profiles",
        reference.target,
      );
    case "mkosi-image":
      return preferredMkosiEntry(
        document.uri,
        candidates.filter(({ uri }) => mkosiImageName(uri) === reference.target),
        "mkosi.images",
        reference.target,
      );
    case "mkosi-include":
      if (mkosiBuiltInIncludes.has(reference.target)) return [];
      return documentsAtMkosiPath(document.uri, reference.target, candidates);
    case "mkosi-uki-profile":
      return documentsAtMkosiPath(document.uri, reference.target, candidates);
    default:
      return [];
  }
}

export function relativeMkosiPath(sourceUri: string, targetUri: string): string | undefined {
  const source = uriLocation(sourceUri);
  const target = uriLocation(targetUri);
  if (source.origin !== target.origin) return undefined;
  const from = mkosiWorkingDirectory(source.path);
  const fromParts = pathParts(from);
  const targetParts = pathParts(target.path);
  let shared = 0;
  while (
    shared < fromParts.length &&
    shared < targetParts.length &&
    fromParts[shared] === targetParts[shared]
  ) {
    shared += 1;
  }
  const relative = [
    ...Array.from({ length: fromParts.length - shared }, () => ".."),
    ...targetParts.slice(shared),
  ].join("/");
  return relative === "" ? "." : relative;
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

export function analyzeWorkspaceReferences(
  document: ParsedDocument,
  documents: readonly ParsedDocument[],
): readonly CoreDiagnostic[] {
  if (document.dialect === "mkosi") return analyzeMkosiReferences(document, documents);
  if (document.dialect !== "podman-quadlet") return [];
  const available = new Set(
    documents
      .filter(({ dialect }) => dialect === "podman-quadlet")
      .map(({ uri }) => configurationIdentity(uri)),
  );
  return extractReferences(document)
    .filter(({ kind, target }) => kind === "quadlet" && !available.has(target))
    .map(({ target, span }): CoreDiagnostic => ({
      code: "missing-quadlet-reference",
      message:
        "Referenced Quadlet " + target + " was not found in the indexed configuration graph.",
      severity: "error",
      span,
      documentation:
        "https://docs.podman.io/en/latest/markdown/podman-systemd.unit.5.html#quadlet-unit-dependencies",
    }));
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
    if (!owner.includes(".") && !unitTypes.has(owner) && !quadletTypes.has(owner)) {
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

function isDropInAwareName(name: string): boolean {
  const type = name.slice(name.lastIndexOf(".") + 1);
  return unitTypes.has(type) || quadletTypes.has(type);
}

function templateName(name: string): string {
  const at = name.indexOf("@");
  const dot = name.lastIndexOf(".");
  return at < 0 || dot < at ? name : name.slice(0, at + 1) + name.slice(dot);
}

function dropInOwners(name: string): readonly string[] {
  if (!isDropInAwareName(name)) return [name];
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
  const owner = right.owner - left.owner;
  if (left.document.dialect === "podman-quadlet" && right.document.dialect === "podman-quadlet") {
    return owner !== 0
      ? owner
      : path !== 0
        ? path
        : left.document.uri.localeCompare(right.document.uri);
  }
  return path !== 0
    ? path
    : owner !== 0
      ? owner
      : left.document.uri.localeCompare(right.document.uri);
}

function compareUriPrecedence(left: string, right: string): number {
  const rank = loadPathRank(left) - loadPathRank(right);
  return rank !== 0 ? rank : left.localeCompare(right);
}

function loadPathRank(uri: string): number {
  const path = normalizeUriPath(uri);
  if (
    /\/run\/(?:user\/[^/]+\/)?containers\/systemd\//u.test(path) ||
    path.includes("/.local/run/containers/systemd/")
  ) {
    return 50;
  }
  if (path.includes("/.config/containers/systemd/") || path.includes("/etc/containers/systemd/")) {
    return 40;
  }
  if (path.includes("/usr/share/containers/systemd/")) return 10;
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

function referenceKind(node: AssignmentNode): Reference["kind"] | undefined {
  if (unitReferenceSettings.has(node.name)) return "unit";
  if (node.name === "Documentation") return "documentation";
  if (node.definition?.valueKind === "path") {
    return "path";
  }
  return undefined;
}

function extractMkosiReferences(
  document: ParsedDocument,
  node: AssignmentNode,
): readonly Reference[] | undefined {
  const kind = mkosiReferenceKindFor(node.section, node.name);
  if (kind === undefined) return undefined;
  return splitMkosiValues(node.value, node.valueSpan.start).map(({ target, span }) => ({
    sourceUri: document.uri,
    target,
    kind,
    span,
  }));
}

function splitMkosiValues(
  value: string,
  valueOffset: number,
): readonly { readonly target: string; readonly span: TextSpan }[] {
  const result: { target: string; span: TextSpan }[] = [];
  for (const match of value.matchAll(/[^,\s]+/gu)) {
    result.push({
      target: match[0],
      span: {
        start: valueOffset + match.index,
        end: valueOffset + match.index + match[0].length,
      },
    });
  }
  return result;
}

function analyzeMkosiReferences(
  document: ParsedDocument,
  documents: readonly ParsedDocument[],
): readonly CoreDiagnostic[] {
  const result: CoreDiagnostic[] = [];
  for (const reference of extractReferences(document)) {
    if (!reference.kind.startsWith("mkosi-")) continue;
    if (reference.kind === "mkosi-include" && mkosiBuiltInIncludes.has(reference.target)) continue;
    if (reference.target.includes("%")) continue;
    if (resolveMkosiReferenceDocuments(document, reference, documents).length > 0) continue;
    const details = mkosiReferenceDiagnostic(reference);
    result.push({
      code: details.code,
      message: details.message,
      severity: details.severity,
      span: reference.span,
      documentation: "https://www.freedesktop.org/software/mkosi/man/mkosi.html",
    });
  }
  return result;
}

function mkosiReferenceDiagnostic(reference: Reference): {
  readonly code: string;
  readonly message: string;
  readonly severity: CoreDiagnostic["severity"];
} {
  switch (reference.kind) {
    case "mkosi-profile":
      return {
        code: "missing-mkosi-profile",
        message: "Selected mkosi profile " + reference.target + " was not found in mkosi.profiles.",
        severity: "warning",
      };
    case "mkosi-image":
      return {
        code: "missing-mkosi-image",
        message: "Required mkosi subimage " + reference.target + " was not found in mkosi.images.",
        severity: "error",
      };
    case "mkosi-uki-profile":
      return {
        code: "missing-mkosi-uki-profile",
        message: "Referenced UKI profile " + reference.target + " was not found in the index.",
        severity: "warning",
      };
    case "mkosi-include":
    case "mkosi":
    case "unit":
    case "path":
    case "quadlet":
    case "documentation":
      return {
        code: "missing-mkosi-include",
        message:
          "Included mkosi configuration " + reference.target + " was not found in the index.",
        severity: "warning",
      };
  }
}

function mkosiCollectionName(
  uri: string,
  collection: "mkosi.profiles" | "mkosi.images",
): string | undefined {
  const parts = pathParts(uriLocation(uri).path);
  const index =
    collection === "mkosi.images" ? parts.indexOf(collection) : parts.lastIndexOf(collection);
  const entry = index < 0 ? undefined : parts[index + 1];
  if (entry === undefined || entry === "") return undefined;
  return entry.endsWith(".conf") ? entry.slice(0, -".conf".length) : entry;
}

function preferredMkosiEntry(
  sourceUri: string,
  documents: readonly ParsedDocument[],
  collection: "mkosi.profiles" | "mkosi.images",
  name: string,
): readonly ParsedDocument[] {
  const source = uriLocation(sourceUri);
  const collectionPath =
    collection === "mkosi.profiles"
      ? mkosiProfilesDirectory(source.path)
      : mkosiImagesDirectory(source.path);
  const scoped = documents.filter((document) => {
    const location = uriLocation(document.uri);
    return location.origin === source.origin && location.path.startsWith(collectionPath + "/");
  });
  const entries = scoped.filter((document) => {
    const parts = pathParts(uriLocation(document.uri).path);
    const index =
      collection === "mkosi.images" ? parts.indexOf(collection) : parts.lastIndexOf(collection);
    if (index < 0) return false;
    const remainder = parts.slice(index + 1);
    return (
      (remainder.length === 1 && [name, name + ".conf"].includes(remainder[0] ?? "")) ||
      (remainder[0] === name && remainder[1] === "mkosi.conf")
    );
  });
  const selected = entries.length > 0 ? entries : [...scoped].sort(compareDocumentUri).slice(0, 1);
  return selected.sort(compareDocumentUri);
}

function documentsAtMkosiPath(
  sourceUri: string,
  target: string,
  documents: readonly ParsedDocument[],
): readonly ParsedDocument[] {
  const resolved = resolvedMkosiPath(sourceUri, target);
  if (resolved === undefined) return [];
  const sourceOrigin = uriLocation(sourceUri).origin;
  const exact = documents.filter((document) => {
    const location = uriLocation(document.uri);
    return location.origin === sourceOrigin && location.path === resolved;
  });
  if (exact.length > 0) return exact.sort(compareDocumentUri);
  const nested = documents.filter((document) => {
    const location = uriLocation(document.uri);
    return location.origin === sourceOrigin && location.path.startsWith(resolved + "/");
  });
  const entry = nested.filter(({ uri }) => uriLocation(uri).path === resolved + "/mkosi.conf");
  return (entry.length > 0 ? entry : nested.slice().sort(compareDocumentUri).slice(0, 1)).sort(
    compareDocumentUri,
  );
}

function compareDocumentUri(left: ParsedDocument, right: ParsedDocument): number {
  return left.uri.localeCompare(right.uri);
}

interface UriLocation {
  readonly origin: string;
  readonly path: string;
}

function uriLocation(uri: string): UriLocation {
  const parsed = /^([A-Za-z][A-Za-z0-9+.-]*:)\/\/([^/]*)(\/[^?#]*)/u.exec(uri);
  if (parsed !== null) {
    let path = parsed[3] ?? "/";
    try {
      path = decodeURIComponent(path);
    } catch {
      // Keep malformed escapes intact so workspace analysis remains total.
    }
    return {
      origin: (parsed[1] ?? "") + "//" + (parsed[2] ?? ""),
      path: normalizeAbsolutePath(path),
    };
  }
  return { origin: "", path: normalizeAbsolutePath(normalizeUriPath(uri)) };
}

function resolvedMkosiPath(sourceUri: string, target: string): string | undefined {
  if (target === "" || /^(?:[A-Za-z][A-Za-z0-9+.-]*:|%)/u.test(target)) return undefined;
  if (target.startsWith("/")) return normalizeAbsolutePath(target);
  const source = uriLocation(sourceUri);
  return normalizeAbsolutePath(mkosiWorkingDirectory(source.path) + "/" + target);
}

function mkosiWorkingDirectory(path: string): string {
  const parts = pathParts(path);
  const name = parts.at(-1) ?? "";
  const confd = parts.lastIndexOf("mkosi.conf.d");
  if (confd >= 0 && confd === parts.length - 2) return "/" + parts.slice(0, confd).join("/");
  for (const collection of ["mkosi.profiles", "mkosi.images"] as const) {
    const index = parts.lastIndexOf(collection);
    if (index >= 0 && index === parts.length - 2) return "/" + parts.slice(0, index).join("/");
  }
  if (["mkosi.local.conf", "mkosi.tools.conf", "mkosi.initrd.conf"].includes(name)) {
    return "/" + parts.slice(0, -1).join("/");
  }
  return "/" + parts.slice(0, -1).join("/");
}

function mkosiProfilesDirectory(path: string): string {
  const parts = pathParts(path);
  const local = parts.indexOf("mkosi.local");
  const base = local >= 0 ? "/" + parts.slice(0, local).join("/") : mkosiWorkingDirectory(path);
  return normalizeAbsolutePath(base + "/mkosi.profiles");
}

function mkosiImagesDirectory(path: string): string {
  return normalizeAbsolutePath(mkosiProjectRoot(path) + "/mkosi.images");
}

function mkosiProjectRoot(path: string): string {
  const parts = pathParts(path);
  const markers = [
    "mkosi.conf.d",
    "mkosi.images",
    "mkosi.initrd.conf",
    "mkosi.local",
    "mkosi.profiles",
    "mkosi.tools.conf",
    "mkosi.uki-profiles",
  ];
  const indices = markers.map((marker) => parts.indexOf(marker)).filter((index) => index >= 0);
  const first = indices.length === 0 ? parts.length - 1 : Math.min(...indices);
  return "/" + parts.slice(0, first).join("/");
}

function normalizeAbsolutePath(path: string): string {
  const result: string[] = [];
  for (const part of path.replaceAll("\\", "/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") result.pop();
    else result.push(part);
  }
  return "/" + result.join("/");
}

function pathParts(path: string): readonly string[] {
  return normalizeAbsolutePath(path).split("/").filter(Boolean);
}

function extractQuadletReferences(
  document: ParsedDocument,
  node: AssignmentNode,
): readonly Reference[] | undefined {
  if (node.section === "Unit" && unitReferenceSettings.has(node.name)) {
    return splitValues(node.value, node.valueSpan.start).map((value) => ({
      sourceUri: document.uri,
      target: value.target,
      kind:
        quadletUnitDependencySettings.has(node.name) &&
        quadletExtensions.some((extension) => value.target.endsWith(extension))
          ? "quadlet"
          : "unit",
      span: value.span,
    }));
  }

  const extensions = quadletReferenceExtensionsFor(document.kind, node.section, node.name);
  if (extensions.length === 0) {
    return isQuadletResourceSetting(node.name) ? [] : undefined;
  }
  const candidates =
    node.name === "Mount"
      ? mountSourceReferences(node.value, node.valueSpan.start)
      : node.name === "Network" || node.name === "Volume"
        ? delimitedReference(node.value, node.valueSpan.start, ":")
        : delimitedReference(node.value, node.valueSpan.start);
  return candidates
    .filter(
      ({ target }) =>
        (!requiresNonPathQuadletSource(node.name) || isPlainQuadletIdentity(target)) &&
        extensions.some((extension) => target.endsWith(extension)),
    )
    .map(({ target, span }) => ({
      sourceUri: document.uri,
      target,
      kind: "quadlet",
      span,
    }));
}

function isQuadletResourceSetting(name: string): boolean {
  return [
    "Artifact",
    "Build",
    "Image",
    "ImageVolume",
    "Mount",
    "Network",
    "Pod",
    "Volume",
  ].includes(name);
}

function isPlainQuadletIdentity(value: string): boolean {
  return value !== "" && !value.startsWith(".") && !value.startsWith("/");
}

function requiresNonPathQuadletSource(name: string): boolean {
  return name === "Mount" || name === "Volume";
}

function delimitedReference(
  value: string,
  valueOffset: number,
  delimiter?: string,
): readonly { readonly target: string; readonly span: TextSpan }[] {
  const end = delimiter === undefined ? value.length : value.indexOf(delimiter);
  const raw = value.slice(0, end < 0 ? value.length : end);
  const leading = raw.length - raw.trimStart().length;
  let target = raw.trim();
  let quoteOffset = 0;
  if (
    target.length >= 2 &&
    ((target.startsWith('"') && target.endsWith('"')) ||
      (target.startsWith("'") && target.endsWith("'")))
  ) {
    target = target.slice(1, -1);
    quoteOffset = 1;
  }
  if (target === "") return [];
  const start = valueOffset + leading + quoteOffset;
  return [{ target, span: { start, end: start + target.length } }];
}

function mountSourceReferences(
  value: string,
  valueOffset: number,
): readonly { readonly target: string; readonly span: TextSpan }[] {
  const fields = parseCsvFields(value);
  if (fields === undefined) return [];

  let mountType = "volume";
  let foundType = false;
  const tokens: CsvField[] = [];
  for (const field of fields) {
    const parts = field.value.split("=");
    if (!foundType && parts.length === 2 && parts[0] === "type") {
      mountType = parts[1] ?? "";
      foundType = true;
    } else {
      tokens.push(field);
    }
  }
  if (!["artifact", "bind", "glob", "image", "volume"].includes(mountType)) return [];

  let selected: { readonly field: CsvField; readonly valueStart: number } | undefined;
  for (const field of tokens) {
    const equals = field.value.indexOf("=");
    if (equals < 0) continue;
    const key = field.value.slice(0, equals);
    if (key === "source" || key === "src") {
      selected = { field, valueStart: equals + 1 };
    }
  }
  if (selected === undefined) return [];
  const target = selected.field.value.slice(selected.valueStart);
  if (target === "") return [];
  const rawStart = selected.field.boundaries[selected.valueStart];
  const rawEnd = selected.field.boundaries[selected.field.value.length];
  if (rawStart === undefined || rawEnd === undefined) return [];
  return [
    {
      target,
      span: { start: valueOffset + rawStart, end: valueOffset + rawEnd },
    },
  ];
}

interface CsvField {
  readonly value: string;
  readonly boundaries: readonly number[];
}

function parseCsvFields(value: string): readonly CsvField[] | undefined {
  const result: CsvField[] = [];
  let index = 0;
  while (index <= value.length) {
    if (value[index] === '"') {
      index += 1;
      let decoded = "";
      const boundaries = [index];
      let closed = false;
      while (index < value.length) {
        if (value[index] === '"') {
          if (value[index + 1] === '"') {
            decoded += '"';
            index += 2;
            boundaries.push(index);
            continue;
          }
          index += 1;
          closed = true;
          break;
        }
        decoded += value[index] ?? "";
        index += 1;
        boundaries.push(index);
      }
      if (!closed || (index < value.length && value[index] !== ",")) return undefined;
      result.push({ value: decoded, boundaries });
    } else {
      const start = index;
      while (index < value.length && value[index] !== ",") {
        if (value[index] === '"') return undefined;
        index += 1;
      }
      result.push({
        value: value.slice(start, index),
        boundaries: Array.from({ length: index - start + 1 }, (_, offset) => start + offset),
      });
    }
    if (index >= value.length) break;
    index += 1;
  }
  return result;
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
