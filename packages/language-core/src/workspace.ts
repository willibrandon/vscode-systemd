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
