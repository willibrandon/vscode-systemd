import { definitionFor, hwdbPropertyFor, isDynamicDirective, sectionsFor } from "./registry.js";
import { analyzeSystemdJson } from "./json-analysis.js";
import { lineSettingsFor, recordFormatFor, udevRuleKeys } from "./line-formats.js";
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

const booleans = new Set([
  "1",
  "0",
  "yes",
  "no",
  "true",
  "false",
  "on",
  "off",
  "y",
  "n",
  "t",
  "f",
  "always",
  "never",
]);
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
  "F",
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
  "m",
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
    if (
      definition.dialect === "mkosi" &&
      definition.section !== "*" &&
      definition.section !== node.section &&
      (targetVersion === "latest" ||
        targetVersion === "auto" ||
        compareVersions(targetVersion, "17") >= 0)
    ) {
      diagnostics.push({
        code: "setting-in-wrong-section",
        message:
          node.name + "= belongs in [" + definition.section + "], not [" + node.section + "].",
        severity: "warning",
        span: node.nameSpan,
        documentation: definition.documentation,
      });
    }
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
      const removed =
        definition.until !== undefined &&
        (targetVersion === "latest" ||
          targetVersion === "auto" ||
          compareVersions(definition.until, targetVersion) <= 0);
      diagnostics.push({
        code: "setting-unavailable",
        message: removed
          ? node.name +
            "= was removed in version " +
            definition.until +
            " but the target is " +
            targetVersion +
            "."
          : node.name +
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
        } else {
          validateTmpfilesFields(node, diagnostics);
        }
        break;
      case "systemd-sysusers":
        validateSysusers(node, diagnostics);
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
        validateBinfmt(node, diagnostics);
        break;
      case "systemd-table":
        validateTable(document.kind, node, diagnostics);
        break;
      case "systemd-udev-rules":
        for (let index = 0; index < node.fields.length; index += 1) {
          validateUdevExpression(node, index, diagnostics);
        }
        break;
      case "systemd-hwdb":
        if (node.fields.length === 2) validateHwdbProperty(node, diagnostics);
        break;
      case "systemd-dns-trust-anchor":
        validateTrustAnchor(document, node, diagnostics);
        break;
      case "systemd-boot":
        validateBootRecord(document, node, diagnostics);
        break;
      case "systemd-sysctl":
        if (!/^-[A-Za-z0-9_.*/-]+$/u.test(node.fields.join(" "))) {
          diagnostics.push({
            code: "invalid-sysctl-line",
            message: "A sysctl line must be an assignment or a '-' exclusion.",
            severity: "error",
            span: node.span,
          });
        }
        break;
      case "systemd-environment":
        validateEnvironmentRecord(document, node, diagnostics);
        break;
      default:
        break;
    }
  }
  if (document.dialect === "systemd-udev-rules") {
    validateUdevControlFlow(document, diagnostics);
  }
  if (document.dialect === "systemd-hwdb") validateHwdbStructure(document, diagnostics);
  validateSingleValueDocument(document, diagnostics);
}

function validateHwdbStructure(document: ParsedDocument, diagnostics: CoreDiagnostic[]): void {
  let state: "none" | "match" | "data" = "none";
  let lastMatch: RecordNode | undefined;
  let properties = new Map<string, RecordNode>();
  let matches = new Set<string>();
  const reset = (): void => {
    state = "none";
    lastMatch = undefined;
    properties = new Map();
    matches = new Set();
  };
  const missingProperty = (): void => {
    if (lastMatch === undefined) return;
    diagnostics.push({
      code: "invalid-record-field",
      message: "An hwdb record requires at least one indented property.",
      severity: "error",
      span: lastMatch.fieldSpans[0] ?? lastMatch.span,
    });
  };

  for (const node of document.nodes) {
    if (node.kind === "comment") continue;
    if (node.kind === "blank") {
      if (state === "match") missingProperty();
      if (state === "data") validateHwdbPropertyDependencies(properties, diagnostics);
      reset();
      continue;
    }
    if (node.kind === "invalid") {
      if (node.raw.startsWith(" ") && state === "match") state = "data";
      continue;
    }
    if (node.kind !== "record") continue;
    if (node.fields.length === 1) {
      if (state === "data") {
        validateHwdbPropertyDependencies(properties, diagnostics);
        fieldError(node, 0, "A blank line is required between hwdb records.", diagnostics);
        reset();
        continue;
      }
      const match = node.fields[0] ?? "";
      validateHwdbMatch(node, diagnostics);
      if (matches.has(match) && !containsTemplate(match)) {
        fieldError(node, 0, "Duplicate match pattern in this hwdb record.", diagnostics, "warning");
      }
      matches.add(match);
      lastMatch = node;
      state = "match";
      continue;
    }
    const key = node.fields[0] ?? "";
    if (state === "none") {
      fieldError(node, 0, "An hwdb property requires a preceding match line.", diagnostics);
      continue;
    }
    if (properties.has(key)) {
      fieldError(node, 0, "Duplicate " + key + " property in this hwdb record.", diagnostics);
    }
    properties.set(key, node);
    state = "data";
  }
  if (state === "match") missingProperty();
  if (state === "data") validateHwdbPropertyDependencies(properties, diagnostics);
}

function validateHwdbMatch(node: RecordNode, diagnostics: CoreDiagnostic[]): void {
  const match = node.fields[0] ?? "";
  if (containsTemplate(match)) return;
  const separator = match.indexOf(":");
  if (separator < 0) return;
  const prefix = match.slice(0, separator);
  const pattern = match.slice(separator + 1);
  const valid =
    prefix === "usb" || prefix === "bluetooth"
      ? /^v(?:\*|[0-9A-F]{4})(?:p(?:\*|[0-9A-F]{4}))?.*\*$/u.test(pattern)
      : prefix === "pci"
        ? /^v(?:\*|[0-9A-F]{8})(?:d(?:\*|[0-9A-F]{8}))?.*\*$/u.test(pattern)
        : true;
  if (!valid) {
    fieldError(
      node,
      0,
      prefix + " hwdb patterns require the complete uppercase hexadecimal vendor/device form.",
      diagnostics,
    );
  }
}

function validateHwdbPropertyDependencies(
  properties: ReadonlyMap<string, RecordNode>,
  diagnostics: CoreDiagnostic[],
): void {
  for (const [dependent, required] of [
    ["MOUSE_WHEEL_CLICK_COUNT_HORIZONTAL", "MOUSE_WHEEL_CLICK_COUNT"],
    ["MOUSE_WHEEL_CLICK_ANGLE_HORIZONTAL", "MOUSE_WHEEL_CLICK_ANGLE"],
    ["MOUSE_WHEEL_CLICK_COUNT_HORIZONTAL", "MOUSE_WHEEL_CLICK_ANGLE_HORIZONTAL"],
    ["MOUSE_WHEEL_CLICK_COUNT", "MOUSE_WHEEL_CLICK_ANGLE"],
  ] as const) {
    const node = properties.get(dependent);
    if (node !== undefined && !properties.has(required)) {
      fieldError(node, 0, dependent + " requires " + required + ".", diagnostics);
    }
  }
}

function validateHwdbProperty(node: RecordNode, diagnostics: CoreDiagnostic[]): void {
  const name = node.fields[0] ?? "";
  const value = (node.fields[1] ?? "").trim();
  if (!/^[A-Z][A-Za-z0-9_]*$/u.test(name) && !containsTemplate(name)) {
    fieldError(
      node,
      0,
      "An hwdb property name must start with an uppercase letter and contain only letters, digits, and underscores.",
      diagnostics,
    );
    return;
  }
  if (containsTemplate(value)) return;
  const definition = hwdbPropertyFor(name);
  if (definition === undefined) return;
  let valid = true;
  switch (definition.valueKind) {
    case "string":
      valid = value !== "";
      break;
    case "boolean":
    case "input-flag":
    case "enum":
      valid = definition.choices.includes(value);
      break;
    case "integer":
      valid = /^\d+$/u.test(value);
      break;
    case "xkb":
      valid = value === "" || /^[A-Za-z0-9+\-/@._]+$/u.test(value);
      break;
    case "dpi": {
      const settings = value.split(/\s+/u).filter(Boolean);
      valid =
        settings.length > 0 &&
        settings.every((setting) => /^\*?\d+(?:@\d+)?$/u.test(setting)) &&
        settings.filter((setting) => setting.startsWith("*")).length <= 1;
      break;
    }
    case "mount-matrix": {
      const real = "[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)";
      const row = real + "\\s*,\\s*" + real + "\\s*,\\s*" + real;
      valid = new RegExp("^" + row + "\\s*;\\s*" + row + "\\s*;\\s*" + row + "$", "u").test(value);
      if (valid) {
        valid = value
          .split(";")
          .every((matrixRow) => matrixRow.split(",").some((number) => Number(number) !== 0));
      }
      break;
    }
    case "keycode":
      valid = /^(?:!|!?[A-Za-z0-9_]+)$/u.test(value);
      break;
    case "evdev-axis":
      valid = /^[-0-9:]+$/u.test(value);
      break;
    default:
      break;
  }
  if (!valid) {
    const expectation =
      definition.choices.length > 0
        ? " Expected " +
          definition.choices.map((choice) => (choice === "" ? "empty" : choice)).join(", ") +
          "."
        : " Expected a valid " + definition.valueKind.replaceAll("-", " ") + " value.";
    fieldError(node, 1, name + " has an invalid value." + expectation, diagnostics);
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

interface ParsedUdevExpression {
  readonly key: string;
  readonly attribute?: string;
  readonly operator: string;
  readonly value: string;
  readonly escaped: boolean;
  readonly caseInsensitive: boolean;
}

function parseUdevExpression(value: string): ParsedUdevExpression | undefined {
  let cursor = 0;
  while (isUdevKeyCharacter(value[cursor] ?? "")) cursor += 1;
  if (cursor === 0) return undefined;
  const key = value.slice(0, cursor);
  let attribute: string | undefined;
  if (value[cursor] === "{") {
    const closing = value.indexOf("}", cursor + 1);
    if (closing < 0) return undefined;
    attribute = value.slice(cursor + 1, closing);
    cursor = closing + 1;
  }
  while (isHorizontalWhitespace(value[cursor] ?? "")) cursor += 1;
  const operator = ["==", "!=", ":=", "+=", "-=", "="].find((candidate) =>
    value.startsWith(candidate, cursor),
  );
  if (operator === undefined) return undefined;
  cursor += operator.length;
  while (isHorizontalWhitespace(value[cursor] ?? "")) cursor += 1;
  let escaped = false;
  let caseInsensitive = false;
  for (let prefixIndex = 0; prefixIndex < 2; prefixIndex += 1) {
    if (value[cursor] === "e" && !escaped) {
      escaped = true;
      cursor += 1;
    } else if (value[cursor] === "i" && !caseInsensitive) {
      caseInsensitive = true;
      cursor += 1;
    } else {
      break;
    }
  }
  if (value[cursor] !== '"') return undefined;
  cursor += 1;
  const valueStart = cursor;
  let closing = -1;
  while (cursor < value.length) {
    if (value[cursor] === "\\" && (escaped || value[cursor + 1] === '"')) {
      cursor += 2;
      continue;
    }
    if (value[cursor] === '"') {
      closing = cursor;
      cursor += 1;
      break;
    }
    cursor += 1;
  }
  if (closing < 0) return undefined;
  while (isHorizontalWhitespace(value[cursor] ?? "")) cursor += 1;
  if (cursor !== value.length) return undefined;
  return {
    key,
    ...(attribute === undefined ? {} : { attribute }),
    operator,
    value: value.slice(valueStart, closing),
    escaped,
    caseInsensitive,
  };
}

function validateUdevExpression(
  node: RecordNode,
  index: number,
  diagnostics: CoreDiagnostic[],
): void {
  const expression = parseUdevExpression(node.fields[index] ?? "");
  if (expression === undefined) {
    fieldError(
      node,
      index,
      "Malformed udev expression; values must be double quoted.",
      diagnostics,
    );
    return;
  }
  const definition = udevRuleKeys.find(({ name }) => name === expression.key);
  if (definition === undefined) {
    fieldError(node, index, "Unknown udev rule key " + expression.key + ".", diagnostics);
    return;
  }
  if (
    (definition.attribute === "required" && expression.attribute === undefined) ||
    (definition.attribute === "forbidden" && expression.attribute !== undefined) ||
    expression.attribute === ""
  ) {
    fieldError(
      node,
      index,
      definition.name +
        (definition.attribute === "required"
          ? " requires a non-empty {...} attribute."
          : " does not accept a {...} attribute."),
      diagnostics,
    );
  } else if (
    expression.attribute !== undefined &&
    definition.attributeChoices.length > 0 &&
    !definition.attributeChoices.includes(expression.attribute)
  ) {
    fieldError(
      node,
      index,
      definition.name +
        " attribute must be one of: " +
        definition.attributeChoices.join(", ") +
        ".",
      diagnostics,
    );
  }
  if (!definition.operators.includes(expression.operator)) {
    fieldError(
      node,
      index,
      definition.name + " expects " + definition.operators.join(", ") + ".",
      diagnostics,
    );
  }
  if (expression.caseInsensitive && !definition.caseInsensitive) {
    fieldError(node, index, definition.name + ' does not accept the i"..." prefix.', diagnostics);
  }
  if (expression.value.includes("\0") || escapedUdevNul(expression)) {
    fieldError(node, index, "udev values cannot contain NUL.", diagnostics);
  }
  if (definition.name === "OPTIONS" && !isUdevOption(expression.value)) {
    fieldError(node, index, "Unknown or invalid udev OPTIONS value.", diagnostics);
  }
  if (
    definition.name === "TEST" &&
    expression.attribute !== undefined &&
    !/^[0-7]{3,4}$/u.test(expression.attribute)
  ) {
    fieldError(node, index, "TEST mode must be a three- or four-digit octal mode.", diagnostics);
  }
}

function escapedUdevNul(expression: ParsedUdevExpression): boolean {
  return (
    expression.escaped &&
    /\\(?:0(?:[^0-7]|$)|x00(?:[^0-9A-Fa-f]|$)|u0000(?:[^0-9A-Fa-f]|$)|U00000000(?:[^0-9A-Fa-f]|$))/u.test(
      expression.value,
    )
  );
}

function isUdevOption(value: string): boolean {
  if (
    new Set([
      "string_escape=none",
      "string_escape=replace",
      "watch",
      "nowatch",
      "db_persist",
      "dump",
      "dump-json",
    ]).has(value)
  ) {
    return true;
  }
  if (/^link_priority=[+-]?\d+$/u.test(value)) return true;
  if (/^static_node=.+$/u.test(value)) return true;
  return /^log_level=(?:emerg|alert|crit|err|warning|notice|info|debug|reset)$/u.test(value);
}

function validateUdevControlFlow(document: ParsedDocument, diagnostics: CoreDiagnostic[]): void {
  const expressions = document.nodes.flatMap((node) =>
    node.kind === "record"
      ? node.fields
          .map((field, index) => ({ node, index, expression: parseUdevExpression(field) }))
          .filter(
            (
              entry,
            ): entry is typeof entry & {
              readonly expression: ParsedUdevExpression;
            } => entry.expression !== undefined,
          )
      : [],
  );
  const labels = expressions.filter(({ expression }) => expression.key === "LABEL");
  for (const { node, index, expression } of expressions) {
    if (expression.key !== "GOTO") continue;
    if (
      !labels.some(
        (candidate) =>
          candidate.node.span.start > node.span.start &&
          candidate.expression.value === expression.value,
      )
    ) {
      fieldError(
        node,
        index,
        "GOTO target " + expression.value + " has no later LABEL in this file.",
        diagnostics,
        "warning",
      );
    }
  }
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
  } else if (document.kind === "systemd-boot:kernel-install") {
    if (!lineSettingsFor(document.kind).some(({ name }) => name === node.name)) {
      diagnostics.push({
        code: "unknown-boot-setting",
        message: "Unknown kernel-install setting " + node.name + "=.",
        severity: "warning",
        span: node.nameSpan,
        documentation:
          "https://www.freedesktop.org/software/systemd/man/latest/kernel-install.html#Files",
      });
    }
  }
}

function validateSysusers(node: RecordNode, diagnostics: CoreDiagnostic[]): void {
  checkColumns(node, 2, 6, "sysusers", diagnostics);
  const action = node.fields[0] ?? "";
  if (!/^(?:u!?|g|m|r)$/u.test(action)) {
    fieldError(node, 0, "Sysusers entry type must be u, u!, g, m, or r.", diagnostics);
    return;
  }

  const name = node.fields[1] ?? "";
  if (action === "r") {
    if (name !== "-")
      fieldError(node, 1, "A sysusers r entry must use '-' as its name.", diagnostics);
    const range = node.fields[2] ?? "";
    if (!/^\d+(?:-\d+)?$/u.test(range)) {
      fieldError(node, 2, "A sysusers r entry requires a decimal UID/GID or range.", diagnostics);
    }
  } else if (!isUserGroupName(name) && !containsTemplate(name)) {
    fieldError(node, 1, "Invalid system user or group name.", diagnostics);
  }

  if (action === "m") {
    const group = node.fields[2] ?? "";
    if (!isUserGroupName(group) && !containsTemplate(group)) {
      fieldError(node, 2, "A sysusers m entry requires a valid group name.", diagnostics);
    }
  }
  if (action === "m" || action === "r" || action === "g") {
    const firstUnused = 3;
    for (let index = firstUnused; index < node.fields.length; index += 1) {
      if ((node.fields[index] ?? "-") !== "-") {
        fieldError(node, index, "This sysusers entry type does not use this field.", diagnostics);
      }
    }
  }
  if (action.startsWith("u") && (node.fields[3] ?? "-").includes(":")) {
    fieldError(node, 3, "A sysusers GECOS field may not contain a colon.", diagnostics);
  }
}

function isUserGroupName(value: string): boolean {
  return value.length <= 31 && /^[A-Za-z_][A-Za-z0-9_-]*$/u.test(value);
}

function validateBinfmt(node: RecordNode, diagnostics: CoreDiagnostic[]): void {
  checkColumns(node, 7, 7, "binfmt", diagnostics);
  if (node.fields.length !== 7) return;
  if ((node.fields[0] ?? "") === "") {
    fieldError(node, 0, "A binfmt rule requires a name.", diagnostics);
  }
  if (!new Set(["M", "E"]).has(node.fields[1] ?? "")) {
    fieldError(node, 1, "Binfmt rule type must be M (magic) or E (extension).", diagnostics);
  }
  const offset = node.fields[2] ?? "";
  if (offset !== "" && !/^\d+$/u.test(offset)) {
    fieldError(node, 2, "Binfmt offset must be empty or an unsigned decimal integer.", diagnostics);
  }
  if ((node.fields[3] ?? "") === "") {
    fieldError(node, 3, "A binfmt rule requires magic bytes or an extension.", diagnostics);
  }
  if ((node.fields[5] ?? "") === "") {
    fieldError(node, 5, "A binfmt rule requires an interpreter.", diagnostics);
  }
  const flags = node.fields[6] ?? "";
  if (!hasUniqueCharactersFrom(flags, "POCF")) {
    fieldError(node, 6, "Binfmt flags may contain P, O, C, and F at most once.", diagnostics);
  }
}

function validateTmpfilesFields(node: RecordNode, diagnostics: CoreDiagnostic[]): void {
  const action = node.fields[0] ?? "";
  const type = action[0] ?? "";
  const modifiers = action.slice(1);
  const path = node.fields[1] ?? "";
  if (!path.startsWith("/") && !path.startsWith("%") && !containsTemplate(path)) {
    fieldError(node, 1, "Tmpfiles paths must be absolute after specifier expansion.", diagnostics);
  }
  const argument = node.fields[6];
  const hasArgument = argument !== undefined && argument !== "" && argument !== "-";
  const requiresArgument = new Set(["w", "c", "b", "t", "T", "a", "A", "k", "K", "h", "H"]);
  const rejectsArgument = new Set([
    "d",
    "D",
    "v",
    "q",
    "Q",
    "p",
    "e",
    "x",
    "X",
    "r",
    "R",
    "z",
    "Z",
    "m",
  ]);
  if (requiresArgument.has(type) && !hasArgument) {
    fieldError(node, 6, "Tmpfiles type " + type + " requires an Argument field.", diagnostics);
  } else if (rejectsArgument.has(type) && hasArgument) {
    fieldError(
      node,
      6,
      "Tmpfiles type " + type + " does not accept an Argument field.",
      diagnostics,
    );
  }
  if (modifiers.includes("$") && !"fFdDvqQpLcbCwe".includes(type)) {
    fieldError(
      node,
      0,
      "The tmpfiles '$' modifier is not supported by type " + type + ".",
      diagnostics,
    );
  }
  if (modifiers.includes("?") && type !== "L") {
    fieldError(node, 0, "The tmpfiles '?' modifier is only supported by type L.", diagnostics);
  }
  if (modifiers.includes("~") && "LcbC".includes(type)) {
    fieldError(
      node,
      0,
      "The tmpfiles '~' modifier is not supported by type " + type + ".",
      diagnostics,
    );
  }
  if (modifiers.includes("^") && !hasArgument) {
    fieldError(
      node,
      6,
      "The tmpfiles '^' modifier requires a credential name in Argument.",
      diagnostics,
    );
  }

  const mode = node.fields[2];
  if (mode !== undefined && mode !== "-" && !/^[~:]*(?:0?[0-7]{3,4})$/u.test(mode)) {
    fieldError(node, 2, "Tmpfiles mode must be '-' or an octal file mode.", diagnostics);
  }
  const age = node.fields[5];
  if (age !== undefined && age !== "-") {
    const duration = age.replace(/^~/u, "").replace(/^[abcmABCM]+:/u, "");
    if (!isDuration(duration)) fieldError(node, 5, "Invalid tmpfiles age.", diagnostics);
  }
}

function hasUniqueCharactersFrom(value: string, allowed: string): boolean {
  const seen = new Set<string>();
  for (const character of value) {
    if (!allowed.includes(character) || seen.has(character)) return false;
    seen.add(character);
  }
  return true;
}

function validateTrustAnchor(
  document: ParsedDocument,
  node: RecordNode,
  diagnostics: CoreDiagnostic[],
): void {
  if (document.kind === "systemd-dns-trust-anchor:negative") {
    checkColumns(node, 1, 1, "negative trust anchor", diagnostics);
    if (!isDnsName(node.fields[0] ?? "")) {
      fieldError(node, 0, "Invalid DNS name in negative trust anchor.", diagnostics);
    }
    return;
  }
  if (document.kind !== "systemd-dns-trust-anchor:positive") return;
  checkColumns(node, 7, 7, "positive trust anchor", diagnostics);
  if (node.fields.length !== 7) return;
  if (!isDnsName(node.fields[0] ?? "")) {
    fieldError(node, 0, "Invalid DNS name in positive trust anchor.", diagnostics);
  }
  if ((node.fields[1] ?? "").toUpperCase() !== "IN") {
    fieldError(node, 1, "Trust anchors only support the IN resource-record class.", diagnostics);
  }
  const type = (node.fields[2] ?? "").toUpperCase();
  if (type !== "DS" && type !== "DNSKEY") {
    fieldError(node, 2, "Positive trust anchors support DS and DNSKEY records.", diagnostics);
    return;
  }
  if (type === "DS") validateDsTrustAnchor(node, diagnostics);
  else validateDnskeyTrustAnchor(node, diagnostics);
}

function validateDsTrustAnchor(node: RecordNode, diagnostics: CoreDiagnostic[]): void {
  if (!isUnsignedInteger(node.fields[3] ?? "", 65_535)) {
    fieldError(node, 3, "DS key tag must be an unsigned 16-bit integer.", diagnostics);
  }
  if (!isDnssecAlgorithm(node.fields[4] ?? "")) {
    fieldError(node, 4, "Unknown DNSSEC algorithm.", diagnostics);
  }
  if (!isDnssecDigest(node.fields[5] ?? "")) {
    fieldError(node, 5, "Unknown DNSSEC digest algorithm.", diagnostics);
  }
  const digest = node.fields[6] ?? "";
  if (digest === "" || digest.length % 2 !== 0 || !everyCharacter(digest, 0, isHexDigit)) {
    fieldError(
      node,
      6,
      "DS digest must contain an even number of hexadecimal digits.",
      diagnostics,
    );
  }
}

function validateDnskeyTrustAnchor(node: RecordNode, diagnostics: CoreDiagnostic[]): void {
  const flagsText = node.fields[3] ?? "";
  if (!isUnsignedInteger(flagsText, 65_535)) {
    fieldError(node, 3, "DNSKEY flags must be an unsigned 16-bit integer.", diagnostics);
  } else {
    const flags = Number(flagsText);
    if ((flags & 0x100) === 0) {
      fieldError(node, 3, "A trust-anchor DNSKEY must set the zone-key flag (256).", diagnostics);
    } else if ((flags & 0x80) !== 0) {
      fieldError(node, 3, "A revoked DNSKEY cannot be used as a trust anchor.", diagnostics);
    }
  }
  if ((node.fields[4] ?? "") !== "3") {
    fieldError(node, 4, "DNSKEY protocol must be 3.", diagnostics);
  }
  if (!isDnssecAlgorithm(node.fields[5] ?? "")) {
    fieldError(node, 5, "Unknown DNSSEC algorithm.", diagnostics);
  }
  if (!isBase64(node.fields[6] ?? "")) {
    fieldError(node, 6, "DNSKEY key data must be valid Base64.", diagnostics);
  }
}

function isUnsignedInteger(value: string, maximum: number): boolean {
  if (!/^\d+$/u.test(value)) return false;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= maximum;
}

function isDnssecAlgorithm(value: string): boolean {
  if (isUnsignedInteger(value, 255)) return true;
  return new Set([
    "RSAMD5",
    "DH",
    "DSA",
    "ECC",
    "RSASHA1",
    "DSA-NSEC3-SHA1",
    "RSASHA1-NSEC3-SHA1",
    "RSASHA256",
    "RSASHA512",
    "ECC-GOST",
    "ECDSAP256SHA256",
    "ECDSAP384SHA384",
    "ED25519",
    "ED448",
    "INDIRECT",
    "PRIVATEDNS",
    "PRIVATEOID",
  ]).has(value.toUpperCase());
}

function isDnssecDigest(value: string): boolean {
  if (isUnsignedInteger(value, 255)) return true;
  return new Set(["SHA-1", "SHA-256", "GOST_R_34.11-94", "SHA-384"]).has(value.toUpperCase());
}

function isBase64(value: string): boolean {
  return (
    value !== "" &&
    value.length % 4 === 0 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  );
}

function isDnsName(value: string): boolean {
  if (value === ".") return true;
  const normalized = value.endsWith(".") ? value.slice(0, -1) : value;
  if (normalized === "" || normalized.length > 253) return false;
  return normalized.split(".").every((label) => {
    if (label.length < 1 || label.length > 63) return false;
    return /^[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?$/u.test(label);
  });
}

function validateBootRecord(
  document: ParsedDocument,
  node: RecordNode,
  diagnostics: CoreDiagnostic[],
): void {
  if (document.kind !== "systemd-boot:loader" && document.kind !== "systemd-boot:entry") return;
  const permitsEmpty =
    document.kind === "systemd-boot:entry" &&
    new Set(["options", "devicetree-overlay"]).has(node.fields[0] ?? "");
  if (node.fields.length !== 2 && !permitsEmpty) {
    checkColumns(node, 2, 2, "boot configuration", diagnostics);
    return;
  }
  const setting = node.fields[0] ?? "";
  const known = recordFormatFor(document.kind)?.keywords ?? [];
  if (!known.some(({ name }) => name === setting)) {
    fieldError(
      node,
      0,
      "Unknown " + setting + " boot configuration option.",
      diagnostics,
      "warning",
    );
    return;
  }
  const value = node.fields[1] ?? "";
  if (
    document.kind === "systemd-boot:loader" &&
    [
      "editor",
      "auto-entries",
      "auto-firmware",
      "auto-poweroff",
      "auto-reboot",
      "beep",
      "reboot-for-bitlocker",
    ].includes(setting) &&
    !booleans.has(value.toLowerCase())
  ) {
    fieldError(node, 1, setting + " expects a boolean value.", diagnostics);
  }
  if (document.kind === "systemd-boot:entry" && setting === "profile" && !/^\d+$/u.test(value)) {
    fieldError(node, 1, "Boot entry profile must be an unsigned integer.", diagnostics);
  }
}

function validateEnvironmentRecord(
  document: ParsedDocument,
  node: RecordNode,
  diagnostics: CoreDiagnostic[],
): void {
  if (document.kind === "systemd-environment:hostname") {
    const hostname = node.fields[0] ?? "";
    if (!isHostname(hostname) && !containsTemplate(hostname)) {
      fieldError(node, 0, "Invalid static hostname.", diagnostics);
    }
    return;
  }
  diagnostics.push({
    code: "missing-environment-assignment",
    message: "This file expects a KEY=VALUE assignment.",
    severity: "error",
    span: node.span,
  });
}

function isHostname(value: string): boolean {
  if (value === "" || value.length > 64 || value.startsWith(".") || value.endsWith("."))
    return false;
  return value.split(".").every((label) => {
    if (label.length < 1 || label.length > 63) return false;
    return /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u.test(label);
  });
}

function validateSingleValueDocument(
  document: ParsedDocument,
  diagnostics: CoreDiagnostic[],
): void {
  if (
    document.kind !== "systemd-environment:hostname" &&
    document.kind !== "systemd-boot:entry-token"
  ) {
    return;
  }
  const values = document.nodes.filter((node) => node.kind === "record");
  if (values.length <= 1) return;
  for (const node of values.slice(1)) {
    diagnostics.push({
      code: "unexpected-extra-line",
      message: "This file accepts a single value.",
      severity: "error",
      span: node.span,
    });
  }
}

function validateTable(
  kind: ParsedDocument["kind"],
  node: RecordNode,
  diagnostics: CoreDiagnostic[],
): void {
  switch (kind) {
    case "systemd-table:fstab":
      checkColumns(node, 4, 6, "fstab", diagnostics);
      validateFstab(node, diagnostics);
      break;
    case "systemd-table:crypttab":
      checkColumns(node, 2, 4, "crypttab", diagnostics);
      break;
    case "systemd-table:veritytab":
      checkColumns(node, 4, 5, "veritytab", diagnostics);
      break;
    case "systemd-table:integritytab":
      checkColumns(node, 2, 4, "integritytab", diagnostics);
      break;
    case "systemd-table:clonetab":
      checkColumns(node, 4, 5, "clonetab", diagnostics);
      break;
    default:
      checkColumns(node, 2, 6, "systemd table", diagnostics);
      break;
  }
}

function validateFstab(node: RecordNode, diagnostics: CoreDiagnostic[]): void {
  const mountPoint = node.fields[1] ?? "";
  if (
    mountPoint !== "" &&
    mountPoint !== "none" &&
    mountPoint !== "swap" &&
    !mountPoint.startsWith("/")
  ) {
    fieldError(node, 1, "fstab mount point must be absolute, none, or swap.", diagnostics);
  }
  for (const index of [4, 5]) {
    const value = node.fields[index];
    if (value !== undefined && !/^\d+$/u.test(value)) {
      fieldError(
        node,
        index,
        index === 4 ? "fstab dump frequency must be unsigned." : "fstab pass must be unsigned.",
        diagnostics,
      );
    }
  }
  const catalog = recordFormatFor("systemd-table:fstab")?.fields[3]?.choices ?? [];
  for (const option of (node.fields[3] ?? "").split(",")) {
    if (
      option.startsWith("x-systemd.") &&
      !catalog.some((candidate) =>
        candidate.endsWith("=") ? option.startsWith(candidate) : option === candidate,
      )
    ) {
      fieldError(node, 3, "Unknown systemd fstab option " + option + ".", diagnostics, "warning");
    }
  }
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
  severity: CoreDiagnostic["severity"] = "error",
): void {
  diagnostics.push({
    code: "invalid-record-field",
    message,
    severity,
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
  const introduced =
    definition.since === null ||
    targetVersion === "latest" ||
    targetVersion === "auto" ||
    compareVersions(definition.since, targetVersion) <= 0;
  const notRemoved =
    definition.until === undefined ||
    (targetVersion !== "latest" &&
      targetVersion !== "auto" &&
      compareVersions(targetVersion, definition.until) < 0);
  return introduced && notRemoved;
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
