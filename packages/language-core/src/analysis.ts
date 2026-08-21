import { definitionFor, isDynamicDirective, sectionsFor } from "./registry.js";
import type { AssignmentNode, CoreDiagnostic, ParsedDocument, RecordNode } from "./types.js";

export interface AnalysisOptions {
  readonly targetVersion?: string;
  readonly maxProblems?: number;
}

const booleans = new Set(["1", "0", "yes", "no", "true", "false", "on", "off", "y", "n", "t", "f"]);

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
    analyzeIni(document, diagnostics, options.targetVersion ?? "latest");
  } else if (document.dialect === "systemd-json") {
    analyzeJson(document, diagnostics);
  } else {
    analyzeRecords(document, diagnostics);
  }
  return diagnostics.slice(0, maxProblems);
}

function analyzeIni(
  document: ParsedDocument,
  diagnostics: CoreDiagnostic[],
  targetVersion: string,
): void {
  const knownSections = new Set(sectionsFor(document.dialect));
  for (const node of document.nodes) {
    if (node.kind === "section") {
      if (knownSections.size > 0 && !knownSections.has(node.name)) {
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
    if (node.section === null) {
      diagnostics.push({
        code: "setting-outside-section",
        message: "Setting is outside a section.",
        severity: "error",
        span: node.nameSpan,
      });
      continue;
    }
    const definition = node.definition ?? definitionFor(document.dialect, node.section, node.name);
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
    if (definition.deprecated) {
      diagnostics.push({
        code: "deprecated-setting",
        message: node.name + "= is deprecated.",
        severity: "warning",
        span: node.nameSpan,
        documentation: definition.documentation,
      });
    }
    if (
      definition.since !== null &&
      targetVersion !== "latest" &&
      targetVersion !== "auto" &&
      compareVersions(definition.since, targetVersion) > 0
    ) {
      diagnostics.push({
        code: "setting-unavailable",
        message:
          node.name +
          "= requires version " +
          definition.since +
          " but the target is " +
          targetVersion +
          ".",
        severity: "warning",
        span: node.nameSpan,
        documentation: definition.documentation,
      });
    }
    validateValue(node, definition.valueKind, definition.choices, diagnostics);
  }
  validateRequiredSections(document, diagnostics);
}

function validateValue(
  node: AssignmentNode,
  valueKind: string,
  choices: readonly string[],
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
      valid = /^[+-]?(?:\d+|0x[0-9a-f]+|0o[0-7]+)$/iu.test(value);
      expectation = "an integer";
      break;
    case "duration":
      valid =
        /^(?:infinity|[+-]?(?:\d+(?:\.\d+)?\s*(?:ns|us|µs|ms|s|sec|m|min|h|hr|d|day|w|week|month|y|year)?\s*)+)$/iu.test(
          value,
        );
      expectation = "a systemd time span";
      break;
    case "size":
      valid = /^(?:infinity|[+-]?\d+(?:\.\d+)?\s*(?:[KMGTPE]i?B?|B|%)?)$/iu.test(value);
      expectation = "a byte size or percentage";
      break;
    case "address":
      valid =
        /^(?:\[[0-9a-f:]+\]|[0-9a-f:]+|(?:\d{1,3}\.){3}\d{1,3}|[A-Za-z0-9_.-]+)(?:\/\d{1,3})?(?::\d+)?(?:\s+.*)?$/iu.test(
          value,
        );
      expectation = "an address, prefix, or hostname";
      break;
    case "path":
      valid = !value.includes("\0");
      expectation = "a path";
      break;
    default:
      break;
  }
  if (choices.length > 0) {
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

function validateRequiredSections(document: ParsedDocument, diagnostics: CoreDiagnostic[]): void {
  const present = new Set(
    document.nodes.filter((node) => node.kind === "section").map((node) => node.name),
  );
  const normalized = decodeURIComponent(document.uri).toLowerCase();
  const required =
    document.dialect === "podman-quadlet"
      ? quadletSection(normalized)
      : document.dialect === "systemd-unit"
        ? unitSection(normalized)
        : undefined;
  if (required !== undefined && !present.has(required)) {
    diagnostics.push({
      code: "missing-required-section",
      message: "This file requires a [" + required + "] section.",
      severity: "error",
      span: { start: 0, end: Math.min(document.source.length, 1) },
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
        if (!/^[fFdDvVqQpLp+cCbCxXrRzZtThHaA]!?[+~-]*$/u.test(node.fields[0] ?? "")) {
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
          if (
            !/^[A-Za-z0-9_{}.-]+(?:\{[^}]+\})?\s*(?:==|!=|:=|\+=|-=|=)\s*.+$/u.test(
              node.fields[index] ?? "",
            )
          ) {
            fieldError(node, index, "Malformed udev match or assignment.", diagnostics);
          }
        }
        break;
      default:
        break;
    }
  }
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

function analyzeJson(document: ParsedDocument, diagnostics: CoreDiagnostic[]): void {
  if (diagnostics.some((diagnostic) => diagnostic.code === "systemd-json-syntax")) return;
  const value: unknown = JSON.parse(document.source);
  const normalized = document.uri.toLowerCase();
  if (normalized.includes(".pcrlock") && !Array.isArray(value)) {
    diagnostics.push({
      code: "invalid-pcrlock-root",
      message: "A .pcrlock file must contain a CEL-JSON array.",
      severity: "error",
      span: { start: 0, end: Math.min(document.source.length, 1) },
    });
  }
  if (normalized.endsWith(".rr") && !(Array.isArray(value) || isObject(value))) {
    diagnostics.push({
      code: "invalid-rr-root",
      message: "A .rr file must contain a DNS record object or an array of record objects.",
      severity: "error",
      span: { start: 0, end: Math.min(document.source.length, 1) },
    });
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

function unitSection(uri: string): string | undefined {
  const match = /\.(service|socket|timer|path|mount|automount|swap)(?:\.|$)/u.exec(uri)?.[1];
  return match === undefined ? undefined : match.slice(0, 1).toUpperCase() + match.slice(1);
}

function quadletSection(uri: string): string | undefined {
  const match = /\.(artifact|build|container|image|kube|network|pod|volume)(?:\.|$)/u.exec(
    uri,
  )?.[1];
  return match === undefined ? undefined : match.slice(0, 1).toUpperCase() + match.slice(1);
}

function compareVersions(left: string, right: string): number {
  return Number.parseInt(left, 10) - Number.parseInt(right.replace(/^v/u, ""), 10);
}

function containsTemplate(value: string): boolean {
  return /(?:<%|\{\{|\{%|@[^@]+@)/u.test(value);
}

function isObject(value: unknown): boolean {
  return typeof value === "object" && value !== null;
}
