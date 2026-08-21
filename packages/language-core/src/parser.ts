import { definitionFor } from "./registry.js";
import { classifyDocument } from "./document-kind.js";
import type {
  AssignmentNode,
  CoreDiagnostic,
  DialectId,
  InvalidNode,
  ParsedDocument,
  RecordNode,
  SyntaxNode,
  TextSpan,
} from "./types.js";

const iniDialects = new Set<DialectId>([
  "systemd-unit",
  "systemd-network",
  "systemd-config",
  "podman-quadlet",
  "mkosi",
]);

interface PhysicalLine {
  readonly line: number;
  readonly start: number;
  readonly end: number;
  readonly fullEnd: number;
  readonly text: string;
}

export function parse(
  source: string,
  dialect: DialectId,
  uri = "untitled:systemd",
): ParsedDocument {
  const lineStarts = computeLineStarts(source);
  const kind = classifyDocument(uri, dialect);
  if (dialect === "systemd-json") return parseJson(source, dialect, kind, uri, lineStarts);
  const physical = physicalLines(source);
  const diagnostics: CoreDiagnostic[] = [];
  const nodes =
    iniDialects.has(dialect) && kind !== "mkosi:version"
      ? parseIni(physical, dialect, kind, diagnostics)
      : parseRecords(physical, dialect, kind, diagnostics);
  return { uri, source, dialect, kind, nodes, diagnostics, lineStarts };
}

export function detectDialect(
  uri: string,
  source: string,
  preferred?: DialectId,
): DialectId | undefined {
  if (preferred !== undefined) return preferred;
  const normalized = normalizedUriPath(uri);
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
  const stripped = stripCompoundSuffixes(basename);
  const dropInCandidate = /\/([^/]+)\.d\/[^/]+(?:\.ignore)?$/u.exec(normalized)?.[1] ?? "";
  const dropInOwner =
    /(?:\.(?:service|socket|timer|path|mount|automount|swap|target|device|slice|scope|network|netdev|link|dnssd|dns-delegate)|\.conf)$/u.test(
      dropInCandidate,
    )
      ? dropInCandidate
      : "";
  const effective = dropInOwner || stripped;

  if (isMkosiPath(normalized, effective)) return "mkosi";
  if (isQuadletPath(normalized, effective, source)) return "podman-quadlet";
  if (
    /\.(?:service|socket|timer|path|mount|automount|swap|target|device|slice|scope)$/u.test(
      effective,
    )
  ) {
    return "systemd-unit";
  }
  if (/\.(?:network|netdev|link|dnssd|dns-delegate)$/u.test(effective)) {
    return "systemd-network";
  }
  if (effective.endsWith(".nspawn") || isSystemdIniName(effective, normalized)) {
    return "systemd-config";
  }
  if (normalized.includes("/tmpfiles.d/")) return "systemd-tmpfiles";
  if (normalized.includes("/sysusers.d/")) return "systemd-sysusers";
  if (effective.endsWith(".rules")) return "systemd-udev-rules";
  if (effective.endsWith(".hwdb")) return "systemd-hwdb";
  if (
    normalized.includes("/environment.d/") ||
    /^(?:hostname|os-release|initrd-release|machine-info|locale\.conf|vconsole\.conf)$/u.test(
      effective,
    ) ||
    normalized.includes("/extension-release.d/")
  ) {
    return "systemd-environment";
  }
  if (normalized.includes("/sysctl.d/")) return "systemd-sysctl";
  if (normalized.includes("/modules-load.d/")) return "systemd-modules-load";
  if (normalized.includes("/binfmt.d/")) return "systemd-binfmt";
  if (effective.endsWith(".preset")) return "systemd-preset";
  if (/^(?:fstab|crypttab|veritytab|integritytab|clonetab)$/u.test(effective)) {
    return "systemd-table";
  }
  if (
    /^(?:loader\.conf|install\.conf|cmdline|entry-token)$/u.test(effective) ||
    /\/loader\/entries\/[^/]+\.conf$/u.test(normalized) ||
    normalized.includes("/kernel/install.conf.d/")
  ) {
    return "systemd-boot";
  }
  if (/\.(?:positive|negative)$/u.test(effective)) return "systemd-dns-trust-anchor";
  if (/\.(?:pcrlock|rr)$/u.test(effective)) return "systemd-json";
  return detectFromContent(source);
}

function normalizedUriPath(uri: string): string {
  let decoded = uri;
  try {
    decoded = decodeURIComponent(uri);
  } catch {
    // Preserve malformed escapes so detection cannot interrupt editor document handling.
  }
  return (decoded.split(/[?#]/u)[0] ?? decoded).replaceAll("\\", "/").toLowerCase();
}

function parseIni(
  physical: readonly PhysicalLine[],
  dialect: DialectId,
  documentKind: ParsedDocument["kind"],
  diagnostics: CoreDiagnostic[],
): SyntaxNode[] {
  const nodes: SyntaxNode[] = [];
  let section: string | null = null;
  for (let index = 0; index < physical.length; index += 1) {
    const first = physical[index];
    if (first === undefined) continue;
    const logical = [first];
    let text = first.text;
    let continuing = dialect !== "mkosi" && hasContinuation(text);
    while (continuing && index + 1 < physical.length) {
      text = text.replace(/\\\s*$/u, "");
      index += 1;
      const next = physical[index];
      if (next === undefined) break;
      logical.push(next);
      if (/^\s*[#;]/u.test(next.text)) continue;
      text += next.text.trimStart();
      continuing = hasContinuation(next.text);
    }
    if (dialect === "mkosi" && isMkosiAssignment(text)) {
      while (index + 1 < physical.length && continuesMkosiValue(physical, index + 1)) {
        index += 1;
        const next = physical[index];
        if (next !== undefined) logical.push(next);
      }
      text = mkosiLogicalText(logical);
    }
    const raw = logical.map((line) => line.text).join("\n");
    const span = {
      start: first.start,
      end: logical.at(-1)?.end ?? first.end,
    };
    const trimmed = text.replace(/^\uFEFF/u, "").trim();
    if (trimmed === "") {
      nodes.push({ kind: "blank", span, line: first.line, raw });
      continue;
    }
    if (/^[#;]/u.test(trimmed)) {
      nodes.push({
        kind: "comment",
        span,
        line: first.line,
        raw,
        text: trimmed.slice(1),
      });
      continue;
    }
    if (isTemplateLine(trimmed)) {
      nodes.push(record(first, span, raw, [trimmed], [span]));
      continue;
    }
    if (trimmed.startsWith("[")) {
      const match = /^\[\s*([A-Za-z0-9_:.-]+)\s*\]$/u.exec(trimmed);
      if (match === null) {
        invalid(nodes, diagnostics, first, span, raw, "Malformed section header.");
      } else {
        section = match[1] ?? "";
        const offset = first.text.indexOf(section);
        nodes.push({
          kind: "section",
          span,
          line: first.line,
          raw,
          name: section,
          nameSpan: {
            start: first.start + Math.max(0, offset),
            end: first.start + Math.max(0, offset) + section.length,
          },
        });
      }
      continue;
    }
    const equals = text.indexOf("=");
    if (equals < 0) {
      invalid(nodes, diagnostics, first, span, raw, "Setting must contain '='.");
      continue;
    }
    const nameText = text.slice(0, equals);
    const name = nameText.trim();
    if (!/^[A-Za-z][A-Za-z0-9_:@{}.-]*$/u.test(name)) {
      invalid(nodes, diagnostics, first, span, raw, "Invalid setting name.");
      continue;
    }
    const valueText = text.slice(equals + 1);
    const value = valueText.trim();
    const nameOffset = first.text.indexOf(name);
    const firstValueOffset = first.text.indexOf("=") + 1;
    const valueLeading = first.text.slice(firstValueOffset).search(/\S/u);
    const valueStart =
      value === ""
        ? first.start + firstValueOffset
        : first.start + firstValueOffset + Math.max(0, valueLeading);
    const definition = definitionFor(dialect, section, name, documentKind);
    const node: AssignmentNode = {
      kind: "assignment",
      span,
      line: first.line,
      raw,
      section,
      name,
      nameSpan: {
        start: first.start + Math.max(0, nameOffset),
        end: first.start + Math.max(0, nameOffset) + name.length,
      },
      value,
      valueSpan: { start: valueStart, end: span.end },
      physicalLines: logical.map((line) => line.line),
      ...(definition === undefined ? {} : { definition }),
    };
    nodes.push(node);
  }
  return nodes;
}

function isMkosiAssignment(text: string): boolean {
  const trimmed = stripMkosiComment(text).trim();
  return !trimmed.startsWith("[") && !trimmed.startsWith("#") && trimmed.includes("=");
}

function continuesMkosiValue(physical: readonly PhysicalLine[], start: number): boolean {
  for (let index = start; index < physical.length; index += 1) {
    const text = physical[index]?.text ?? "";
    const semantic = stripMkosiComment(text);
    if (semantic.trim() === "") continue;
    return /^\s/u.test(text);
  }
  return false;
}

function mkosiLogicalText(logical: readonly PhysicalLine[]): string {
  return logical
    .map((line, index) => {
      const text = stripMkosiComment(line.text);
      return index === 0 ? text : text.trim();
    })
    .filter((line, index) => index === 0 || line !== "")
    .join("\n");
}

function stripMkosiComment(text: string): string {
  const comment = text.indexOf("#");
  return comment < 0 ? text : text.slice(0, comment);
}

function parseRecords(
  physical: readonly PhysicalLine[],
  dialect: DialectId,
  documentKind: ParsedDocument["kind"],
  diagnostics: CoreDiagnostic[],
): SyntaxNode[] {
  const nodes: SyntaxNode[] = [];
  for (const line of physical) {
    const span = { start: line.start, end: line.end };
    const trimmed = line.text.replace(/^\uFEFF/u, "").trim();
    if (trimmed === "") {
      nodes.push({ kind: "blank", span, line: line.line, raw: line.text });
      continue;
    }
    if (isRecordComment(trimmed, dialect)) {
      nodes.push({
        kind: "comment",
        span,
        line: line.line,
        raw: line.text,
        text: trimmed.slice(1),
      });
      continue;
    }
    if (isTemplateLine(trimmed)) {
      nodes.push(record(line, span, line.text, [trimmed], [span]));
      continue;
    }
    if (dialect === "systemd-hwdb") {
      const property = /^\s+([A-Za-z0-9_.{}-]+)\s*=(.*)$/u.exec(line.text);
      if (/^\s/u.test(line.text) && property === null) {
        invalid(nodes, diagnostics, line, span, line.text, "Malformed hwdb property.");
        continue;
      }
      const fields =
        property === null ? [trimmed] : [property[1] ?? "", (property[2] ?? "").trim()];
      nodes.push(record(line, span, line.text, fields, fieldSpans(line, fields)));
      continue;
    }
    if (dialect === "systemd-udev-rules") {
      const fields = splitQuoted(trimmed, ",");
      nodes.push(record(line, span, line.text, fields, fieldSpans(line, fields)));
      continue;
    }
    if (dialect === "systemd-environment" && documentKind !== "systemd-environment:hostname") {
      const assignment = parseSimpleAssignment(line, span);
      if (assignment !== undefined) {
        nodes.push(assignment);
        continue;
      }
    }
    if (dialect === "systemd-sysctl") {
      const assignment = parseSimpleAssignment(line, span);
      if (assignment !== undefined) {
        nodes.push(assignment);
        continue;
      }
    }
    if (dialect === "systemd-boot" && documentKind === "systemd-boot:kernel-install") {
      const assignment = parseSimpleAssignment(line, span);
      if (assignment !== undefined) {
        nodes.push(assignment);
        continue;
      }
    }
    if (
      documentKind === "systemd-environment:hostname" ||
      documentKind === "systemd-boot:entry-token"
    ) {
      const token = wholeLineToken(line);
      nodes.push(record(line, span, line.text, [token.text], [token.span]));
      continue;
    }
    if (documentKind === "systemd-boot:loader" || documentKind === "systemd-boot:entry") {
      const tokens = splitWhitespace(line, 2);
      nodes.push(record(line, span, line.text, tokens.fields, tokens.spans));
      continue;
    }
    if (dialect === "systemd-tmpfiles") {
      const tokens = splitWhitespace(line, 7);
      nodes.push(record(line, span, line.text, tokens.fields, tokens.spans));
      continue;
    }
    if (
      dialect === "systemd-sysusers" ||
      dialect === "systemd-modules-load" ||
      dialect === "systemd-preset" ||
      dialect === "systemd-table" ||
      dialect === "systemd-dns-trust-anchor" ||
      documentKind === "systemd-boot:kernel-command-line"
    ) {
      const tokens = splitWhitespace(line);
      nodes.push(record(line, span, line.text, tokens.fields, tokens.spans));
      continue;
    }
    if (dialect === "systemd-boot") {
      const equals = line.text.indexOf("=");
      if (equals >= 0) {
        const name = line.text.slice(0, equals).trim();
        const value = line.text.slice(equals + 1).trim();
        const nameStart = line.start + line.text.indexOf(name);
        nodes.push({
          kind: "assignment",
          span,
          line: line.line,
          raw: line.text,
          section: null,
          name,
          nameSpan: { start: nameStart, end: nameStart + name.length },
          value,
          valueSpan: {
            start: line.start + equals + 1,
            end: line.end,
          },
          physicalLines: [line.line],
        });
        continue;
      }
    }
    const fields =
      dialect === "systemd-binfmt" && trimmed.startsWith(":")
        ? splitBinfmt(trimmed)
        : splitQuoted(trimmed, " ");
    nodes.push(record(line, span, line.text, fields, fieldSpans(line, fields)));
  }
  return nodes;
}

function isRecordComment(trimmed: string, dialect: DialectId): boolean {
  if (trimmed.startsWith("#")) return true;
  return (
    trimmed.startsWith(";") &&
    [
      "systemd-tmpfiles",
      "systemd-sysusers",
      "systemd-environment",
      "systemd-sysctl",
      "systemd-modules-load",
      "systemd-binfmt",
      "systemd-preset",
      "systemd-dns-trust-anchor",
    ].includes(dialect)
  );
}

function parseSimpleAssignment(line: PhysicalLine, span: TextSpan): AssignmentNode | undefined {
  const equals = line.text.indexOf("=");
  if (equals < 0) return undefined;
  const name = line.text.slice(0, equals).trim();
  const value = line.text.slice(equals + 1).trim();
  const nameOffset = line.text.indexOf(name);
  const valueText = line.text.slice(equals + 1);
  const valueLeading = valueText.search(/\S/u);
  const valueStart =
    value === "" ? line.start + equals + 1 : line.start + equals + 1 + Math.max(0, valueLeading);
  return {
    kind: "assignment",
    span,
    line: line.line,
    raw: line.text,
    section: null,
    name,
    nameSpan: {
      start: line.start + Math.max(0, nameOffset),
      end: line.start + Math.max(0, nameOffset) + name.length,
    },
    value,
    valueSpan: { start: valueStart, end: line.end },
    physicalLines: [line.line],
  };
}

interface FieldTokens {
  readonly fields: readonly string[];
  readonly spans: readonly TextSpan[];
}

function wholeLineToken(line: PhysicalLine): { readonly text: string; readonly span: TextSpan } {
  const text = line.text.trim();
  const offset = line.text.indexOf(text);
  return {
    text,
    span: {
      start: line.start + Math.max(0, offset),
      end: line.start + Math.max(0, offset) + text.length,
    },
  };
}

/**
 * Split fields using systemd's whitespace-and-quoting lexical rules while retaining raw text.
 * When maximumFields is reached, the final field owns the complete remaining text. This is
 * required for tmpfiles' Argument column and boot-loader option values.
 */
function splitWhitespace(
  line: PhysicalLine,
  maximumFields = Number.POSITIVE_INFINITY,
): FieldTokens {
  const fields: string[] = [];
  const spans: TextSpan[] = [];
  let cursor = 0;
  while (cursor < line.text.length) {
    while (/\s/u.test(line.text[cursor] ?? "")) cursor += 1;
    if (cursor >= line.text.length) break;
    const start = cursor;
    if (fields.length + 1 === maximumFields) {
      const text = line.text.slice(start).trimEnd();
      fields.push(text);
      spans.push({ start: line.start + start, end: line.start + start + text.length });
      break;
    }
    let quote = "";
    let escaped = false;
    while (cursor < line.text.length) {
      const character = line.text[cursor] ?? "";
      if (escaped) {
        escaped = false;
        cursor += 1;
      } else if (character === "\\") {
        escaped = true;
        cursor += 1;
      } else if (quote !== "") {
        if (character === quote) quote = "";
        cursor += 1;
      } else if (character === '"' || character === "'") {
        quote = character;
        cursor += 1;
      } else if (/\s/u.test(character)) {
        break;
      } else {
        cursor += 1;
      }
    }
    const text = line.text.slice(start, cursor);
    fields.push(text);
    spans.push({ start: line.start + start, end: line.start + cursor });
  }
  return { fields, spans };
}

function parseJson(
  source: string,
  dialect: DialectId,
  kind: ParsedDocument["kind"],
  uri: string,
  lineStarts: readonly number[],
): ParsedDocument {
  const diagnostics: CoreDiagnostic[] = [];
  const lines = physicalLines(source);
  const nodes: SyntaxNode[] = lines.map((line) => {
    const span = { start: line.start, end: line.end };
    if (line.text.trim() === "") return { kind: "blank", span, line: line.line, raw: line.text };
    return record(line, span, line.text, [line.text], [span]);
  });
  try {
    JSON.parse(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const position = /position\s+(\d+)/u.exec(message)?.[1];
    const start = position === undefined ? 0 : Math.min(source.length, Number(position));
    diagnostics.push({
      code: "systemd-json-syntax",
      message,
      severity: "error",
      span: { start, end: Math.min(source.length, start + 1) },
    });
  }
  return { uri, source, dialect, kind, nodes, diagnostics, lineStarts };
}

function invalid(
  nodes: SyntaxNode[],
  diagnostics: CoreDiagnostic[],
  line: PhysicalLine,
  span: TextSpan,
  raw: string,
  message: string,
): void {
  const node: InvalidNode = { kind: "invalid", span, line: line.line, raw, message };
  nodes.push(node);
  diagnostics.push({
    code: "systemd-syntax",
    message,
    severity: "error",
    span,
  });
}

function record(
  line: PhysicalLine,
  span: TextSpan,
  raw: string,
  fields: readonly string[],
  spans: readonly TextSpan[],
): RecordNode {
  return {
    kind: "record",
    span,
    line: line.line,
    raw,
    fields,
    fieldSpans: spans,
  };
}

function fieldSpans(line: PhysicalLine, fields: readonly string[]): TextSpan[] {
  let cursor = 0;
  return fields.map((field) => {
    const found = line.text.indexOf(field, cursor);
    const offset = found < 0 ? cursor : found;
    cursor = offset + field.length;
    return { start: line.start + offset, end: line.start + offset + field.length };
  });
}

function splitQuoted(value: string, separator: "," | " "): string[] {
  const result: string[] = [];
  let current = "";
  let quote = "";
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === "\\") {
      current += character;
      escaped = true;
    } else if (quote !== "") {
      current += character;
      if (character === quote) quote = "";
    } else if (character === '"' || character === "'") {
      current += character;
      quote = character;
    } else if (
      (separator === "," && character === ",") ||
      (separator === " " && /\s/u.test(character))
    ) {
      if (current !== "") {
        result.push(separator === "," ? current.trim() : current);
        current = "";
      }
    } else {
      current += character;
    }
  }
  if (current !== "") result.push(separator === "," ? current.trim() : current);
  return result;
}

function splitBinfmt(value: string): string[] {
  const delimiter = value[0] ?? ":";
  return value.split(delimiter).slice(1);
}

function physicalLines(source: string): PhysicalLine[] {
  const result: PhysicalLine[] = [];
  let start = 0;
  let line = 0;
  while (start <= source.length) {
    let end = source.indexOf("\n", start);
    if (end < 0) end = source.length;
    const carriage = end > start && source[end - 1] === "\r" ? 1 : 0;
    result.push({
      line,
      start,
      end: end - carriage,
      fullEnd: end < source.length ? end + 1 : end,
      text: source.slice(start, end - carriage),
    });
    if (end === source.length) break;
    start = end + 1;
    line += 1;
  }
  return result;
}

function computeLineStarts(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

function hasContinuation(value: string): boolean {
  const match = /(\\+)\s*$/u.exec(value);
  return match !== null && (match[1]?.length ?? 0) % 2 === 1;
}

function isTemplateLine(value: string): boolean {
  return /^(?:<%|%>|\{\{|\}\}|\{%|%\}|@[^@]+@)/u.test(value);
}

function stripCompoundSuffixes(name: string): string {
  let result = name;
  const suffixes = [".ignore", ".backup", ".template", ".tmpl", ".jinja", ".j2", ".erb", ".in"];
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of suffixes) {
      if (result.endsWith(suffix)) {
        result = result.slice(0, -suffix.length);
        changed = true;
      }
    }
  }
  return result;
}

function isQuadletPath(normalized: string, effective: string, source: string): boolean {
  if (/\.(?:artifact|build|container|image|kube|pod|volume)$/u.test(effective)) return true;
  if (!effective.endsWith(".network")) return false;
  if (/\/(?:containers\/systemd|quadlets?|podman)\//u.test(normalized)) return true;
  return (
    /^\s*\[(?:Container|Volume|Kube|Image|Build|Pod|Artifact|Quadlet)\]\s*$/mu.test(source) ||
    /^\s*(?:NetworkName|DisableDNS|IPAMDriver|NetworkDeleteOnStop)\s*=/mu.test(source)
  );
}

function isMkosiPath(normalized: string, effective: string): boolean {
  return (
    /^mkosi\.(?:conf|local\.conf|tools\.conf|initrd\.conf|version)$/u.test(effective) ||
    /\/mkosi\.(?:conf\.d|profiles|images|local|tools\.conf|initrd\.conf|uki-profiles)\//u.test(
      normalized,
    )
  );
}

function isSystemdIniName(effective: string, normalized: string): boolean {
  return (
    /^(?:system|user|journald(?:@[^/]+)?|logind|resolved|timesyncd|networkd|coredump|oomd|homed|pstore|sleep|systemd-sleep|iocost|journal-remote|journal-upload|udev|sysext|confext|ukify|uki)\.conf$/u.test(
      effective,
    ) ||
    /\/(?:repart|sysupdate)\.d\/[^/]+\.conf$/u.test(normalized) ||
    /\/mkosi\.repart\/(?:.+\/)?[^/]+\.conf$/u.test(normalized) ||
    /\/portable\/profile\/.+\.conf$/u.test(normalized)
  );
}

function detectFromContent(source: string): DialectId | undefined {
  if (
    /^\s*\[(?:Unit|Service|Socket|Timer|Path|Mount|Automount|Swap|Install)\]\s*$/mu.test(source)
  ) {
    return "systemd-unit";
  }
  if (/^\s*\[(?:Match|Network|NetDev|Link|DHCPv4|DHCPv6|Route)\]\s*$/mu.test(source)) {
    return "systemd-network";
  }
  if (/^\s*\[(?:Container|Volume|Kube|Image|Build|Pod|Artifact|Quadlet)\]\s*$/mu.test(source)) {
    return "podman-quadlet";
  }
  if (
    /^\s*\[(?:Distribution|Output|Content|Build|Runtime|Host|Match|Config)\]\s*$/mu.test(source)
  ) {
    return "mkosi";
  }
  return undefined;
}
