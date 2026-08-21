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

export type UnitDocumentType =
  | "service"
  | "socket"
  | "timer"
  | "path"
  | "mount"
  | "automount"
  | "swap"
  | "target"
  | "device"
  | "slice"
  | "scope";

export type NetworkDocumentType = "network" | "netdev" | "link" | "dnssd" | "dns-delegate";

export type SystemdConfigFamily =
  | "system"
  | "user"
  | "journald"
  | "logind"
  | "resolved"
  | "timesyncd"
  | "networkd"
  | "coredump"
  | "oomd"
  | "homed"
  | "pstore"
  | "sleep"
  | "iocost"
  | "journal-remote"
  | "journal-upload"
  | "udev"
  | "sysext"
  | "confext"
  | "ukify"
  | "uki"
  | "nspawn"
  | "repart"
  | "sysupdate"
  | "portable-profile"
  | "generic";

export type QuadletDocumentType =
  "artifact" | "build" | "container" | "image" | "kube" | "network" | "pod" | "volume";

export type MkosiDocumentType =
  | "main"
  | "drop-in"
  | "profile"
  | "subimage"
  | "local"
  | "tools"
  | "uki-profile"
  | "version"
  | "generic";

export type DocumentKind =
  | `systemd-unit:${UnitDocumentType}`
  | `systemd-network:${NetworkDocumentType}`
  | `systemd-config:${SystemdConfigFamily}`
  | "systemd-tmpfiles:tmpfiles"
  | "systemd-sysusers:sysusers"
  | "systemd-udev-rules:rules"
  | "systemd-hwdb:hwdb"
  | `systemd-environment:${"environment" | "os-release" | "hostname" | "machine-info" | "locale" | "vconsole"}`
  | "systemd-sysctl:sysctl"
  | "systemd-modules-load:modules-load"
  | "systemd-binfmt:binfmt"
  | "systemd-preset:preset"
  | `systemd-table:${"fstab" | "crypttab" | "veritytab" | "integritytab" | "clonetab"}`
  | `systemd-boot:${"loader" | "entry" | "kernel-command-line" | "entry-token" | "kernel-install"}`
  | `systemd-dns-trust-anchor:${"positive" | "negative"}`
  | `systemd-json:${"pcrlock" | "rr"}`
  | `podman-quadlet:${QuadletDocumentType}`
  | `mkosi:${MkosiDocumentType}`
  | `${DialectId}:unknown`;

export interface TargetVersions {
  readonly systemd: string;
  readonly podman: string;
  readonly mkosi: string;
}

export type ValueKind =
  "string" | "boolean" | "number" | "duration" | "size" | "path" | "address" | "list" | "command";

export type AssignmentMode = "replace" | "append" | "append-no-reset" | "first";

export interface SourceSpan {
  readonly start: number;
  readonly end: number;
}

export type TextSpan = SourceSpan;

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
  readonly exclusiveChoices?: boolean;
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

export interface LineFieldDefinition {
  readonly name: string;
  readonly summary: string;
  readonly required: boolean;
  readonly choices: readonly string[];
}

export interface LineKeywordDefinition {
  readonly name: string;
  readonly summary: string;
  readonly choices: readonly string[];
}

export interface LineFormatDefinition {
  readonly name: string;
  readonly summary: string;
  readonly documentation: string;
  readonly fields: readonly LineFieldDefinition[];
  readonly keywords: readonly LineKeywordDefinition[];
  readonly repeatLastField: boolean;
}

export interface LineSettingDefinition {
  readonly name: string;
  readonly summary: string;
  readonly documentation: string;
  readonly choices: readonly string[];
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

export interface ParseResult {
  readonly source: string;
  readonly nodes: readonly SyntaxNode[];
  readonly diagnostics: readonly CoreDiagnostic[];
  readonly lineStarts: readonly number[];
}

export interface ParsedDocument extends ParseResult {
  readonly uri: string;
  readonly canonicalUri?: string;
  readonly dialect: DialectId;
  readonly kind: DocumentKind;
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
  readonly kind:
    | "unit"
    | "path"
    | "quadlet"
    | "mkosi"
    | "mkosi-include"
    | "mkosi-profile"
    | "mkosi-image"
    | "mkosi-uki-profile"
    | "documentation";
  readonly span: TextSpan;
}

export interface SemanticModel {
  readonly document: ParsedDocument;
  readonly sections: readonly SectionNode[];
  readonly assignments: readonly AssignmentNode[];
  readonly records: readonly RecordNode[];
  readonly references: readonly Reference[];
}

export interface ReferenceGraphNode {
  readonly identity: string;
  readonly sourceUris: readonly string[];
}

export interface ReferenceGraphEdge {
  readonly source: string;
  readonly target: string;
  readonly kind: Reference["kind"];
  readonly sourceUri: string;
  readonly span: SourceSpan;
}

export interface ReferenceGraph {
  readonly nodes: readonly ReferenceGraphNode[];
  readonly edges: readonly ReferenceGraphEdge[];
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
