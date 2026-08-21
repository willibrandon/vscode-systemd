import {
  findNodeAtLocation,
  findNodeAtOffset,
  getLocation,
  getNodePath,
  parseTree,
} from "jsonc-parser";
import type { JSONPath, Node } from "jsonc-parser";
import type { DocumentKind, TextSpan } from "./types.js";
import { userDbDefinition } from "./userdb.js";
import type { JsonValueType } from "./userdb.js";

type JsonChoice = string | number | boolean | null;

export interface SystemdJsonFieldDefinition {
  readonly name: string;
  readonly types: readonly JsonValueType[];
  readonly description: string;
  readonly documentation: string;
  readonly required?: boolean;
  readonly choices?: readonly JsonChoice[];
  readonly itemTypes?: readonly JsonValueType[];
  readonly itemChoices?: readonly JsonChoice[];
}

export interface SystemdJsonPropertyContext {
  readonly fields: readonly SystemdJsonFieldDefinition[];
  readonly prefix: string;
}

export interface SystemdJsonValueContext {
  readonly field: SystemdJsonFieldDefinition;
  readonly arrayItem: boolean;
  readonly quoted: boolean;
  readonly replaceSpan?: TextSpan;
}

export interface SystemdJsonFieldContext {
  readonly field: SystemdJsonFieldDefinition;
  readonly span: TextSpan;
}

export type SystemdJsonNodeType = "object" | "array" | "string" | "number" | "boolean" | "null";

export interface SystemdJsonOutlineNode {
  readonly name: string;
  readonly type: SystemdJsonNodeType;
  readonly detail?: string;
  readonly span: TextSpan;
  readonly selectionSpan: TextSpan;
  readonly children: readonly SystemdJsonOutlineNode[];
}

export interface SystemdJsonSemanticSpan {
  readonly type: "property" | "string" | "number" | "keyword";
  readonly span: TextSpan;
}

const systemdUserDbDocumentation =
  "https://www.freedesktop.org/software/systemd/man/latest/systemd.userdb.html";
const systemdPcrlockDocumentation =
  "https://www.freedesktop.org/software/systemd/man/latest/systemd.pcrlock.html";
const systemdResourceRecordDocumentation =
  "https://www.freedesktop.org/software/systemd/man/latest/systemd.rr.html";

const pcrlockRecordFields: readonly SystemdJsonFieldDefinition[] = [
  field("pcr", ["integer"], "TPM2 platform configuration register, from 0 through 23.", {
    documentation: systemdPcrlockDocumentation,
  }),
  field("nv_index", ["integer"], "TPM2 non-volatile index measured by this record.", {
    documentation: systemdPcrlockDocumentation,
  }),
  field("digests", ["array"], "Cryptographic digests recorded for this measurement.", {
    documentation: systemdPcrlockDocumentation,
    required: true,
  }),
  field("content_type", ["string"], "Type of the optional human-readable event content.", {
    documentation: systemdPcrlockDocumentation,
    choices: ["systemd"],
  }),
  field("content", ["object"], "Human-readable event content for systemd measurements.", {
    documentation: systemdPcrlockDocumentation,
  }),
];

const pcrlockDigestFields: readonly SystemdJsonFieldDefinition[] = [
  field("hashAlg", ["string"], "TPM2 hash algorithm used for this digest.", {
    documentation: systemdPcrlockDocumentation,
    required: true,
    choices: ["sha1", "sha256", "sha384", "sha512"],
  }),
  field("digest", ["string"], "Even-length hexadecimal digest of at most 64 bytes.", {
    documentation: systemdPcrlockDocumentation,
  }),
];

const pcrlockContentFields: readonly SystemdJsonFieldDefinition[] = [
  field("string", ["string"], "Human-readable representation of the measured event.", {
    documentation: systemdPcrlockDocumentation,
  }),
  field("eventType", ["string"], "Event type associated with the measured content.", {
    documentation: systemdPcrlockDocumentation,
  }),
];

const resourceRecordFields: readonly SystemdJsonFieldDefinition[] = [
  field("key", ["object"], "DNS resource-record key.", {
    documentation: systemdResourceRecordDocumentation,
    required: true,
  }),
  field("address", ["string", "array"], "IPv4 or IPv6 address for A and AAAA records.", {
    documentation: systemdResourceRecordDocumentation,
  }),
  field("name", ["string"], "Target name for NS, CNAME, PTR, and DNAME records.", {
    documentation: systemdResourceRecordDocumentation,
  }),
];

const resourceRecordKeyFields: readonly SystemdJsonFieldDefinition[] = [
  field("class", ["integer"], "Numeric DNS class; defaults to IN (1).", {
    documentation: systemdResourceRecordDocumentation,
    choices: [1],
  }),
  field("type", ["integer"], "Numeric DNS record type supported by systemd-resolved.", {
    documentation: systemdResourceRecordDocumentation,
    required: true,
    choices: [1, 2, 5, 12, 28, 39],
  }),
  field("name", ["string"], "Owner name for the DNS resource record.", {
    documentation: systemdResourceRecordDocumentation,
    required: true,
  }),
];

export function systemdJsonPropertyContext(
  source: string,
  kind: DocumentKind,
  offset: number,
): SystemdJsonPropertyContext | undefined {
  if (!kind.startsWith("systemd-json:")) return undefined;
  const location = getLocation(source, offset);
  if (!location.isAtPropertyKey || location.path.length === 0) return undefined;
  const key = location.path.at(-1);
  if (typeof key !== "string") return undefined;
  const objectPath = location.path.slice(0, -1);
  const fields = systemdJsonFieldsFor(kind, objectPath);
  if (fields.length === 0) return { fields: [], prefix: key };
  const root = parseTree(source, [], { allowTrailingComma: false, disallowComments: true });
  const existing = objectPropertyNames(root, objectPath);
  return {
    fields: fields.filter((candidate) => candidate.name === key || !existing.has(candidate.name)),
    prefix: key,
  };
}

export function systemdJsonValueContext(
  source: string,
  kind: DocumentKind,
  offset: number,
): SystemdJsonValueContext | undefined {
  if (!kind.startsWith("systemd-json:")) return undefined;
  const location = getLocation(source, offset);
  if (location.isAtPropertyKey || location.path.length === 0) return undefined;
  const last = location.path.at(-1);
  if (typeof last === "string") {
    const field = systemdJsonFieldsFor(kind, location.path.slice(0, -1)).find(
      (candidate) => candidate.name === last,
    );
    return field === undefined
      ? undefined
      : {
          field,
          arrayItem: false,
          ...jsonStringReplacement(location.previousNode, offset),
        };
  }
  if (typeof last !== "number" || location.path.length < 2) return undefined;
  const property = location.path.at(-2);
  if (typeof property !== "string") return undefined;
  const field = systemdJsonFieldsFor(kind, location.path.slice(0, -2)).find(
    (candidate) => candidate.name === property,
  );
  return field === undefined
    ? undefined
    : {
        field,
        arrayItem: true,
        ...jsonStringReplacement(location.previousNode, offset),
      };
}

export function systemdJsonFieldContext(
  source: string,
  kind: DocumentKind,
  offset: number,
): SystemdJsonFieldContext | undefined {
  if (!kind.startsWith("systemd-json:")) return undefined;
  const root = parseTree(source, [], { allowTrailingComma: false, disallowComments: true });
  if (root === undefined) return undefined;
  const selected = findNodeAtOffset(root, offset, true);
  if (selected === undefined) return undefined;
  const keyNode = propertyKeyNode(selected);
  if (keyNode === undefined) return undefined;
  const path = getNodePath(keyNode);
  const name = path.at(-1);
  if (typeof name !== "string") return undefined;
  const field = systemdJsonFieldsFor(kind, path.slice(0, -1)).find(
    (candidate) => candidate.name === name,
  );
  return field === undefined
    ? undefined
    : {
        field,
        span: { start: keyNode.offset, end: keyNode.offset + keyNode.length },
      };
}

export function systemdJsonFieldsFor(
  kind: DocumentKind,
  objectPath: readonly (string | number)[],
): readonly SystemdJsonFieldDefinition[] {
  if (kind === "systemd-json:user" || kind === "systemd-json:group") {
    if (objectPath.length !== 0) return [];
    const recordKind = kind === "systemd-json:user" ? "user" : "group";
    const definition = userDbDefinition(recordKind);
    return definition.fields
      .filter((candidate) => candidate.sensitive !== true)
      .map((candidate) => ({
        name: candidate.name,
        types: candidate.types,
        description: candidate.description,
        documentation: definition.documentation || systemdUserDbDocumentation,
        ...(definition.required.includes(candidate.name) ? { required: true } : {}),
        ...(candidate.choices === undefined ? {} : { choices: candidate.choices }),
        ...(candidate.itemTypes === undefined ? {} : { itemTypes: candidate.itemTypes }),
        ...(candidate.itemChoices === undefined ? {} : { itemChoices: candidate.itemChoices }),
      }));
  }
  if (kind === "systemd-json:pcrlock") {
    if (matchesPath(objectPath, ["#"])) return pcrlockRecordFields;
    if (matchesPath(objectPath, ["#", "digests", "#"])) return pcrlockDigestFields;
    if (matchesPath(objectPath, ["#", "content"])) return pcrlockContentFields;
    return [];
  }
  if (kind === "systemd-json:rr") {
    const recordPath = objectPath.length === 0 || matchesPath(objectPath, ["#"]);
    if (recordPath) return resourceRecordFields;
    if (matchesPath(objectPath, ["key"]) || matchesPath(objectPath, ["#", "key"])) {
      return resourceRecordKeyFields;
    }
  }
  return [];
}

export function systemdJsonOutline(source: string): readonly SystemdJsonOutlineNode[] {
  const root = jsonRoot(source);
  return root === undefined ? [] : outlineChildren(root);
}

export function systemdJsonFoldingSpans(source: string): readonly TextSpan[] {
  const root = jsonRoot(source);
  if (root === undefined) return [];
  const spans: TextSpan[] = [];
  visitJson(root, (node) => {
    if (node.type === "object" || node.type === "array") spans.push(nodeTextSpan(node));
  });
  return spans;
}

export function systemdJsonSelectionSpans(source: string, offset: number): readonly TextSpan[] {
  const root = jsonRoot(source);
  const selected = root === undefined ? undefined : findNodeAtOffset(root, offset, true);
  if (selected === undefined) return [];
  const spans: TextSpan[] = [];
  let current: Node | undefined = selected;
  while (current !== undefined) {
    const span = nodeTextSpan(current);
    if (!spans.some((candidate) => candidate.start === span.start && candidate.end === span.end)) {
      spans.push(span);
    }
    current = current.parent;
  }
  return spans;
}

export function systemdJsonSemanticSpans(source: string): readonly SystemdJsonSemanticSpan[] {
  const root = jsonRoot(source);
  if (root === undefined) return [];
  const spans: SystemdJsonSemanticSpan[] = [];
  visitJson(root, (node) => {
    if (node.type === "property") {
      const key = node.children?.[0];
      if (key !== undefined) spans.push({ type: "property", span: nodeTextSpan(key) });
      return;
    }
    if (node.parent?.type === "property" && node.parent.children?.[0] === node) return;
    if (node.type === "string" || node.type === "number") {
      spans.push({ type: node.type, span: nodeTextSpan(node) });
    } else if (node.type === "boolean" || node.type === "null") {
      spans.push({ type: "keyword", span: nodeTextSpan(node) });
    }
  });
  return spans;
}

function field(
  name: string,
  types: readonly JsonValueType[],
  description: string,
  options: Omit<SystemdJsonFieldDefinition, "name" | "types" | "description">,
): SystemdJsonFieldDefinition {
  return { name, types, description, ...options };
}

function objectPropertyNames(root: Node | undefined, path: JSONPath): ReadonlySet<string> {
  const objectNode = root === undefined ? undefined : findNodeAtLocation(root, path);
  if (objectNode?.type !== "object") return new Set();
  const names = (objectNode.children ?? [])
    .map((property) => property.children?.[0]?.value as unknown)
    .filter((name): name is string => typeof name === "string");
  return new Set(names);
}

function propertyKeyNode(node: Node): Node | undefined {
  if (
    node.type === "string" &&
    node.parent?.type === "property" &&
    node.parent.children?.[0] === node
  )
    return node;
  if (node.type === "property") return node.children?.[0];
  if (node.parent?.type === "property") return node.parent.children?.[0];
  return undefined;
}

function matchesPath(actual: readonly (string | number)[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length &&
    expected.every((part, index) =>
      part === "#" ? typeof actual[index] === "number" : actual[index] === part,
    )
  );
}

function jsonStringReplacement(
  previousNode: Node | undefined,
  offset: number,
): Pick<SystemdJsonValueContext, "quoted" | "replaceSpan"> {
  if (
    previousNode?.type !== "string" ||
    offset < previousNode.offset + 1 ||
    offset > previousNode.offset + previousNode.length
  ) {
    return { quoted: false };
  }
  return {
    quoted: true,
    replaceSpan: {
      start: previousNode.offset + 1,
      end: Math.max(previousNode.offset + 1, previousNode.offset + previousNode.length - 1),
    },
  };
}

function jsonRoot(source: string): Node | undefined {
  return parseTree(source, [], { allowTrailingComma: false, disallowComments: true });
}

function outlineChildren(container: Node): readonly SystemdJsonOutlineNode[] {
  if (container.type === "object") {
    return (container.children ?? []).flatMap((property) => {
      const key = property.children?.[0];
      const value = property.children?.[1];
      const name: unknown = key?.value;
      return typeof name !== "string" || key === undefined || value === undefined
        ? []
        : [outlineNode(name, property, key, value)];
    });
  }
  if (container.type === "array") {
    return (container.children ?? []).map((value, index) =>
      outlineNode("[" + String(index) + "]", value, value, value),
    );
  }
  return [];
}

function outlineNode(
  name: string,
  rangeNode: Node,
  selectionNode: Node,
  value: Node,
): SystemdJsonOutlineNode {
  const type = value.type === "property" ? "object" : value.type;
  return {
    name,
    type,
    ...(isJsonContainer(value) ? {} : { detail: jsonPrimitiveDetail(value) }),
    span: nodeTextSpan(rangeNode),
    selectionSpan: nodeTextSpan(selectionNode),
    children: outlineChildren(value),
  };
}

function jsonPrimitiveDetail(node: Node): string {
  const value: unknown = node.value;
  const encoded = JSON.stringify(value);
  return encoded;
}

function isJsonContainer(node: Node): boolean {
  return node.type === "object" || node.type === "array";
}

function nodeTextSpan(node: Node): TextSpan {
  return { start: node.offset, end: node.offset + node.length };
}

function visitJson(node: Node, visitor: (node: Node) => void): void {
  visitor(node);
  for (const child of node.children ?? []) visitJson(child, visitor);
}
