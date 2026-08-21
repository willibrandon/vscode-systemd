export type DialectId =
  | "systemd-unit"
  | "systemd-network"
  | "systemd-config"
  | "systemd-tmpfiles"
  | "systemd-sysusers"
  | "systemd-udev-rules"
  | "systemd-hwdb"
  | "systemd-environment"
  | "systemd-sysctl"
  | "systemd-modules-load"
  | "systemd-binfmt"
  | "systemd-preset"
  | "systemd-table"
  | "systemd-boot"
  | "systemd-dns-trust-anchor"
  | "systemd-json"
  | "podman-quadlet"
  | "mkosi";

export type RegistryDialect =
  "systemd-unit" | "systemd-network" | "systemd-config" | "podman-quadlet" | "mkosi";

export type RegistryChannel = "stable" | "preview";

export type ValueKind =
  "string" | "boolean" | "number" | "duration" | "size" | "path" | "address" | "list" | "command";

export type AssignmentMode = "replace" | "append" | "append-no-reset" | "first";

export interface TextSpan {
  readonly start: number;
  readonly end: number;
}

export interface DirectiveDefinition {
  readonly dialect: RegistryDialect;
  readonly section: string;
  readonly name: string;
  readonly valueKind: ValueKind;
  readonly assignmentMode?: AssignmentMode;
  readonly resetGroup?: string;
  readonly since: string | null;
  readonly deprecated: boolean;
  readonly documentation: string;
  readonly summary: string;
  readonly choices: readonly string[];
}

export interface RegistryMetadata {
  readonly schemaVersion: number;
  readonly generatedAt: string;
  readonly upstream: Readonly<{
    systemd: string;
    podman: string;
    mkosi: string;
  }>;
  readonly quadletExtensions: readonly string[];
  readonly dynamicDirectivePatterns: readonly string[];
}

export interface BaseNode {
  readonly span: TextSpan;
  readonly line: number;
  readonly raw: string;
}

export interface BlankNode extends BaseNode {
  readonly kind: "blank";
}

export interface CommentNode extends BaseNode {
  readonly kind: "comment";
  readonly text: string;
}

export interface SectionNode extends BaseNode {
  readonly kind: "section";
  readonly name: string;
  readonly nameSpan: TextSpan;
}

export interface AssignmentNode extends BaseNode {
  readonly kind: "assignment";
  readonly section: string | null;
  readonly name: string;
  readonly nameSpan: TextSpan;
  readonly value: string;
  readonly valueSpan: TextSpan;
  readonly physicalLines: readonly number[];
  readonly definition?: DirectiveDefinition;
}

export interface RecordNode extends BaseNode {
  readonly kind: "record";
  readonly fields: readonly string[];
  readonly fieldSpans: readonly TextSpan[];
}

export interface InvalidNode extends BaseNode {
  readonly kind: "invalid";
  readonly message: string;
}

export type SyntaxNode =
  BlankNode | CommentNode | SectionNode | AssignmentNode | RecordNode | InvalidNode;

export type DiagnosticSeverity = "error" | "warning" | "information" | "hint";

export interface CoreDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly severity: DiagnosticSeverity;
  readonly span: TextSpan;
  readonly documentation?: string;
}

export interface ParsedDocument {
  readonly uri: string;
  readonly source: string;
  readonly dialect: DialectId;
  readonly nodes: readonly SyntaxNode[];
  readonly diagnostics: readonly CoreDiagnostic[];
  readonly lineStarts: readonly number[];
}

export interface FormatOptions {
  readonly insertSpaces: boolean;
  readonly tabSize: number;
  readonly trimTrailingWhitespace: boolean;
  readonly range?: TextSpan;
}

export interface TextEdit {
  readonly span: TextSpan;
  readonly newText: string;
}

export interface Reference {
  readonly sourceUri: string;
  readonly target: string;
  readonly kind: "unit" | "path" | "quadlet" | "mkosi" | "documentation";
  readonly span: TextSpan;
}

export interface EffectiveEntry {
  readonly section: string;
  readonly name: string;
  readonly value: string;
  readonly sourceUri: string;
  readonly sourceLine: number;
  readonly span: TextSpan;
}

export interface EffectiveConfiguration {
  readonly entries: readonly EffectiveEntry[];
  readonly sources: readonly string[];
}
