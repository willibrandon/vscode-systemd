import { definitionFor, isDynamicDirective, sectionsFor } from "./registry.js";
import { analyzeSystemdJson } from "./json-analysis.js";
import type {
  AssignmentNode,
  CoreDiagnostic,
  DirectiveDefinition,
  ParsedDocument,
  RecordNode,
  RegistryDialect,
} from "./types.js";

export interface AnalysisOptions {
  readonly targetVersion?: string;
  readonly targetVersions?: Partial<Readonly<Record<RegistryDialect, string>>>;
  readonly maxProblems?: number;
}

const booleans = new Set(["1", "0", "yes", "no", "true", "false", "on", "off", "y", "n", "t", "f"]);
const durationUnits = [
  "month",
  "year",
  "week",
  "sec",
  "min",
  "day",
  "hr",
  "ns",
  "us",
  "µs",
  "ms",
  "s",
  "m",
  "h",
  "d",
  "w",
  "y",
];
const tmpfilesTypes = new Set([
  "f",
  "w",
  "d",
  "D",
  "e",
  "v",
  "q",
  "Q",
  "p",
  "L",
  "c",
  "b",
  "C",
  "x",
  "X",
  "r",
  "R",
  "z",
  "Z",
  "t",
  "T",
  "h",
  "H",
  "a",
  "A",
  "k",
  "K",
]);
const tmpfilesModifiers = new Set(["!", "+", "-", "=", "~", "^", "$", "?"]);

export function analyze(
  document: ParsedDocument,
  options: AnalysisOptions = {},
): readonly CoreDiagnostic[] {
  const diagnostics = [...document.diagnostics];
  const maxProblems = options.maxProblems ?? 200;
  if (
    ["systemd-unit", "systemd-network", "systemd-config", "podman-quadlet", "mkosi"].includes(
      document.dialect,
    )
  ) {
    analyzeIni(document, diagnostics, options);
  } else if (document.dialect === "systemd-json") {
    if (!diagnostics.some((diagnostic) => diagnostic.code === "systemd-json-syntax")) {
      diagnostics.push(...analyzeSystemdJson(document));
    }
  } else {
    analyzeRecords(document, diagnostics);
  }
  return diagnostics.slice(0, maxProblems);
}

function analyzeIni(
  document: ParsedDocument,
  diagnostics: CoreDiagnostic[],
  options: AnalysisOptions,
): void {
  const knownSections = new Set(sectionsFor(document.dialect, document.kind));
  for (const node of document.nodes) {
    if (node.kind === "section") {
      if (knownSections.size > 0 && !knownSections.has(node.name) && !node.name.startsWith("X-")) {
        diagnostics.push({
          code: "unknown-section",
          message: "Unknown [" + node.name + "] section for " + document.dialect + ".",
          severity: "warning",
          span: node.nameSpan,
        });
      }
      continue;
    }
    if (node.kind !== "assignment") continue;
    if (node.section?.startsWith("X-") === true) continue;
    if (node.section === null) {
      diagnostics.push({
        code: "setting-outside-section",
        message: "Setting is outside a section.",
        severity: "error",
        span: node.nameSpan,
      });
      continue;
    }
    const definition =
      node.definition ?? definitionFor(document.dialect, node.section, node.name, document.kind);
    if (definition === undefined && !isDynamicDirective(node.name)) {
      diagnostics.push({
        code: "unknown-setting",
        message:
          "Unknown " +
          node.name +
          "= setting in [" +
          node.section +
          "] for " +
          document.dialect +
          ".",
        severity: "warning",
        span: node.nameSpan,
        documentation:
          "https://www.freedesktop.org/software/systemd/man/latest/systemd.directives.html",
      });
      continue;
    }
    if (definition === undefined) continue;
    const targetVersion = targetVersionFor(definition, options);
    if (definition.deprecated) {
      diagnostics.push({
        code: "deprecated-setting",
        message: node.name + "= is deprecated.",
        severity: "warning",
        span: node.nameSpan,
        documentation: definition.documentation,
      });
    }
    if (!isDefinitionAvailable(definition, targetVersion)) {
      diagnostics.push({
        code: "setting-unavailable",
        message:
          node.name +
          "= requires version " +
          String(definition.since) +
          " but the target is " +
          targetVersion +
          ".",
        severity: "warning",
        span: node.nameSpan,
        documentation: definition.documentation,
      });
    }
    validateValue(
      node,
      definition.valueKind,
      definition.choices,
      definition.exclusiveChoices === true,
      diagnostics,
    );
  }
  validateRequiredStructure(document, diagnostics);
}

function validateValue(
  node: AssignmentNode,
  valueKind: string,
  choices: readonly string[],
  exclusiveChoices: boolean,
  diagnostics: CoreDiagnostic[],
): void {
  const value = node.value;
  if (value === "" || containsTemplate(value)) return;
  let valid = true;
  let expectation = valueKind;
  switch (valueKind) {
    case "boolean":
      valid = booleans.has(value.toLowerCase());
      expectation = "a boolean such as yes or no";
      break;
    case "number":
      valid = isInteger(value);
      expectation = "an integer";
      break;
    case "duration":
      valid = isDuration(value);
      expectation = "a systemd time span";
      break;
    case "size":
      valid = isSize(value);
      expectation = "a byte size or percentage";
      break;
    case "address":
      valid = isAddress(value);
      expectation = "an address, prefix, or hostname";
      break;
    case "path":
      valid = !value.includes("\0");
      expectation = "a path";
      break;
    default:
      break;
  }
  if (exclusiveChoices && choices.length > 0) {
    valid = choices.includes(value);
    expectation = "one of: " + choices.join(", ");
  }
  if (!valid) {
    diagnostics.push({
      code: "invalid-value",
      message: node.name + "= expects " + expectation + ".",
      severity: "error",
      span: node.valueSpan,
      ...(node.definition?.documentation === undefined
        ? {}
        : { documentation: node.definition.documentation }),
    });
  }
}

function validateRequiredStructure(document: ParsedDocument, diagnostics: CoreDiagnostic[]): void {
  const present = new Set(
    document.nodes.filter((node) => node.kind === "section").map((node) => node.name),
  );
  const required =
    document.dialect === "podman-quadlet"
      ? quadletSection(document.kind)
      : document.dialect === "systemd-unit"
        ? unitSection(document.kind)
        : undefined;
  if (required !== undefined && !present.has(required)) {
    diagnostics.push({
      code: "missing-required-section",
      message: "This file requires a [" + required + "] section.",
      severity: "error",
      span: { start: 0, end: Math.min(document.source.length, 1) },
    });
    return;
  }
  if (document.dialect === "podman-quadlet" && required !== undefined) {
    validateRequiredQuadletSettings(document, required, diagnostics);
  }
}

function validateRequiredQuadletSettings(
  document: ParsedDocument,
  section: string,
  diagnostics: CoreDiagnostic[],
): void {
  const assignments = document.nodes.filter(
    (node): node is AssignmentNode => node.kind === "assignment" && node.value !== "",
  );
  const has = (name: string, settingSection = section): boolean =>
    assignments.some((node) => node.section === settingSection && node.name === name);
  const sectionNode = document.nodes.find(
    (node) => node.kind === "section" && node.name === section,
  );
  const span = sectionNode?.span ?? { start: 0, end: Math.min(document.source.length, 1) };
  const missing: string[] = [];

  if (section === "Artifact" && !has("Artifact")) missing.push("Artifact=");
  if (section === "Container" && !has("Image") && !has("Rootfs")) {
    missing.push("Image= or Rootfs=");
  }
  if (section === "Image" && !has("Image")) missing.push("Image=");
  if (section === "Kube" && !has("Yaml")) missing.push("Yaml=");
  if (section === "Build") {
    if (!has("ImageTag")) missing.push("ImageTag=");
    if (!has("File") && !has("SetWorkingDirectory") && !has("WorkingDirectory", "Service")) {
      missing.push("File=, SetWorkingDirectory=, or [Service] WorkingDirectory=");
    }
  }

  for (const setting of missing) {
    diagnostics.push({
      code: "missing-required-setting",
      message: "[" + section + "] requires " + setting + ".",
      severity: "error",
      span,
    });
  }
}

function analyzeRecords(document: ParsedDocument, diagnostics: CoreDiagnostic[]): void {
  for (const node of document.nodes) {
    if (node.kind === "assignment") {
      validateSimpleAssignment(document, node, diagnostics);
      continue;
    }
    if (node.kind !== "record") continue;
    switch (document.dialect) {
      case "systemd-tmpfiles":
        checkColumns(node, 2, 7, "tmpfiles", diagnostics);
        if (!isTmpfilesAction(node.fields[0] ?? "")) {
          fieldError(node, 0, "Unknown tmpfiles entry type.", diagnostics);
        }
        break;
      case "systemd-sysusers":
        checkColumns(node, 2, 6, "sysusers", diagnostics);
        if (!/^[ugmr]$/u.test(node.fields[0] ?? "")) {
          fieldError(node, 0, "Sysusers entry type must be u, g, m, or r.", diagnostics);
        }
        break;
      case "systemd-preset":
        checkColumns(node, 2, Number.POSITIVE_INFINITY, "preset", diagnostics);
        if (!["enable", "disable", "ignore"].includes(node.fields[0] ?? "")) {
          fieldError(node, 0, "Preset action must be enable, disable, or ignore.", diagnostics);
        }
        break;
      case "systemd-modules-load":
        checkColumns(node, 1, 1, "modules-load", diagnostics);
        break;
      case "systemd-binfmt":
        checkColumns(node, 7, 8, "binfmt", diagnostics);
        break;
      case "systemd-table":
        validateTable(document.uri, node, diagnostics);
        break;
      case "systemd-udev-rules":
        for (let index = 0; index < node.fields.length; index += 1) {
          if (!isUdevExpression(node.fields[index] ?? "")) {
            fieldError(node, index, "Malformed udev match or assignment.", diagnostics);
          }
        }
        break;
      default:
        break;
    }
  }
}

function isInteger(value: string): boolean {
  let start = value.startsWith("+") || value.startsWith("-") ? 1 : 0;
  if (start === value.length) return false;
  if (value.slice(start, start + 2).toLowerCase() === "0x") {
    start += 2;
    return start < value.length && everyCharacter(value, start, isHexDigit);
  }
  if (value.slice(start, start + 2).toLowerCase() === "0o") {
    start += 2;
    return (
      start < value.length &&
      everyCharacter(value, start, (character) => character >= "0" && character <= "7")
    );
  }
  return everyCharacter(value, start, isDigit);
}

function isDuration(value: string): boolean {
  if (value.toLowerCase() === "infinity") return true;
  const normalized = value.toLowerCase();
  let cursor = normalized.startsWith("+") || normalized.startsWith("-") ? 1 : 0;
  let segments = 0;
  while (cursor < normalized.length) {
    const integerStart = cursor;
    while (isDigit(normalized[cursor] ?? "")) cursor += 1;
    if (cursor === integerStart) return false;
    if (normalized[cursor] === ".") {
      cursor += 1;
      const fractionStart = cursor;
      while (isDigit(normalized[cursor] ?? "")) cursor += 1;
      if (cursor === fractionStart) return false;
    }
    while (isHorizontalWhitespace(normalized[cursor] ?? "")) cursor += 1;
    const unit = durationUnits.find((candidate) => normalized.startsWith(candidate, cursor));
    if (unit !== undefined) cursor += unit.length;
    if (unit === undefined && isAsciiLetter(normalized[cursor] ?? "")) return false;
    while (isHorizontalWhitespace(normalized[cursor] ?? "")) cursor += 1;
    segments += 1;
  }
  return segments > 0;
}

function isSize(value: string): boolean {
  if (value.toLowerCase() === "infinity") return true;
  let cursor = value.startsWith("+") || value.startsWith("-") ? 1 : 0;
  const integerStart = cursor;
  while (isDigit(value[cursor] ?? "")) cursor += 1;
  if (cursor === integerStart) return false;
  if (value[cursor] === ".") {
    cursor += 1;
    const fractionStart = cursor;
    while (isDigit(value[cursor] ?? "")) cursor += 1;
    if (cursor === fractionStart) return false;
  }
  while (isHorizontalWhitespace(value[cursor] ?? "")) cursor += 1;
  const suffix = value.slice(cursor).toUpperCase();
  if (suffix === "" || suffix === "B" || suffix === "%") return true;
  if (!["K", "M", "G", "T", "P", "E"].includes(suffix[0] ?? "")) return false;
  return (
    suffix.length === 1 ||
    suffix.slice(1) === "B" ||
    suffix.slice(1) === "I" ||
    suffix.slice(1) === "IB"
  );
}

function isAddress(value: string): boolean {
  if (value === "" || isHorizontalWhitespace(value[0] ?? "")) return false;
  let end = 0;
  while (end < value.length && !isHorizontalWhitespace(value[end] ?? "")) end += 1;
  const endpoint = value.slice(0, end);
  if (!everyCharacter(endpoint, 0, isAddressCharacter)) return false;
  if (!someCharacter(endpoint, isAsciiLetterOrDigit)) return false;
  const opening = endpoint.indexOf("[");
  const closing = endpoint.indexOf("]");
  if ((opening === -1) !== (closing === -1)) return false;
  if (opening !== -1 && (opening !== 0 || closing <= opening + 1)) return false;
  const slash = endpoint.indexOf("/");
  if (slash !== -1) {
    if (endpoint.includes("/", slash + 1)) return false;
    const suffix = endpoint.slice(slash + 1).split(":", 2)[0] ?? "";
    if (suffix.length < 1 || suffix.length > 3 || !everyCharacter(suffix, 0, isDigit)) return false;
  }
  return true;
}

function isTmpfilesAction(action: string): boolean {
  if (!tmpfilesTypes.has(action[0] ?? "")) return false;
  const seen = new Set<string>();
  for (const modifier of action.slice(1)) {
    if (!tmpfilesModifiers.has(modifier) || seen.has(modifier)) return false;
    seen.add(modifier);
  }
  return true;
}

function isUdevExpression(value: string): boolean {
  let cursor = 0;
  while (isUdevKeyCharacter(value[cursor] ?? "")) cursor += 1;
  if (cursor === 0) return false;
  if (value[cursor] === "{") {
    const closing = value.indexOf("}", cursor + 1);
    if (closing <= cursor + 1) return false;
    cursor = closing + 1;
  }
  while (isHorizontalWhitespace(value[cursor] ?? "")) cursor += 1;
  const operator = ["==", "!=", ":=", "+=", "-=", "="].find((candidate) =>
    value.startsWith(candidate, cursor),
  );
  if (operator === undefined) return false;
  cursor += operator.length;
  while (isHorizontalWhitespace(value[cursor] ?? "")) cursor += 1;
  return cursor < value.length;
}

function everyCharacter(
  value: string,
  start: number,
  predicate: (character: string) => boolean,
): boolean {
  for (let index = start; index < value.length; index += 1) {
    if (!predicate(value[index] ?? "")) return false;
  }
  return true;
}

function someCharacter(value: string, predicate: (character: string) => boolean): boolean {
  for (const character of value) {
    if (predicate(character)) return true;
  }
  return false;
}

function isDigit(character: string): boolean {
  return character >= "0" && character <= "9";
}

function isHexDigit(character: string): boolean {
  const normalized = character.toLowerCase();
  return isDigit(character) || (normalized >= "a" && normalized <= "f");
}

function isAsciiLetter(character: string): boolean {
  const normalized = character.toLowerCase();
  return normalized >= "a" && normalized <= "z";
}

function isAsciiLetterOrDigit(character: string): boolean {
  return isAsciiLetter(character) || isDigit(character);
}

function isHorizontalWhitespace(character: string): boolean {
  return character === " " || character === "\t";
}

function isAddressCharacter(character: string): boolean {
  return character !== "" && (isAsciiLetterOrDigit(character) || "_.-:[]/".includes(character));
}

function isUdevKeyCharacter(character: string): boolean {
  return character !== "" && (isAsciiLetterOrDigit(character) || "_.-".includes(character));
}

function validateSimpleAssignment(
  document: ParsedDocument,
  node: AssignmentNode,
  diagnostics: CoreDiagnostic[],
): void {
  if (document.dialect === "systemd-environment") {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(node.name)) {
      diagnostics.push({
        code: "invalid-environment-name",
        message: "Invalid environment variable name.",
        severity: "error",
        span: node.nameSpan,
      });
    }
  } else if (document.dialect === "systemd-sysctl") {
    if (!/^-?[A-Za-z0-9_.*/-]+$/u.test(node.name)) {
      diagnostics.push({
        code: "invalid-sysctl-key",
        message: "Invalid sysctl key or exclusion.",
        severity: "error",
        span: node.nameSpan,
      });
    }
  }
}

function validateTable(uri: string, node: RecordNode, diagnostics: CoreDiagnostic[]): void {
  const name = uri.slice(uri.lastIndexOf("/") + 1).toLowerCase();
  const expected = name === "fstab" ? [4, 6] : name === "clonetab" ? [2, 4] : [2, 4];
  checkColumns(node, expected[0] ?? 2, expected[1] ?? 4, name, diagnostics);
}

function checkColumns(
  node: RecordNode,
  minimum: number,
  maximum: number,
  format: string,
  diagnostics: CoreDiagnostic[],
): void {
  if (node.fields.length < minimum || node.fields.length > maximum) {
    diagnostics.push({
      code: "invalid-column-count",
      message:
        format +
        " record expects " +
        (minimum === maximum ? String(minimum) : String(minimum) + "–" + String(maximum)) +
        " fields; found " +
        String(node.fields.length) +
        ".",
      severity: "error",
      span: node.span,
    });
  }
}

function fieldError(
  node: RecordNode,
  index: number,
  message: string,
  diagnostics: CoreDiagnostic[],
): void {
  diagnostics.push({
    code: "invalid-record-field",
    message,
    severity: "error",
    span: node.fieldSpans[index] ?? node.span,
  });
}

function unitSection(kind: ParsedDocument["kind"]): string | undefined {
  const match = /^systemd-unit:(service|socket|timer|path|mount|automount|swap)$/u.exec(kind)?.[1];
  return match === undefined ? undefined : match.slice(0, 1).toUpperCase() + match.slice(1);
}

function quadletSection(kind: ParsedDocument["kind"]): string | undefined {
  const match = /^podman-quadlet:(artifact|build|container|image|kube|network|pod|volume)$/u.exec(
    kind,
  )?.[1];
  return match === undefined ? undefined : match.slice(0, 1).toUpperCase() + match.slice(1);
}

function compareVersions(left: string, right: string): number {
  if (left === "preview") return right === "preview" ? 0 : 1;
  if (right === "preview") return -1;
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function isDefinitionAvailable(
  definition: DirectiveDefinition,
  targetVersion: string,
): boolean {
  return (
    definition.since === null ||
    targetVersion === "latest" ||
    targetVersion === "auto" ||
    compareVersions(definition.since, targetVersion) <= 0
  );
}

function versionParts(value: string): readonly number[] {
  return value
    .replace(/^v/u, "")
    .split(".")
    .map((part) => Number.parseInt(part, 10))
    .filter((part) => Number.isFinite(part));
}

function targetVersionFor(definition: DirectiveDefinition, options: AnalysisOptions): string {
  return options.targetVersions?.[definition.dialect] ?? options.targetVersion ?? "latest";
}

function containsTemplate(value: string): boolean {
  return /(?:<%|\{\{|\{%|@[^@]+@)/u.test(value);
}
