import { parseTree } from "jsonc-parser";
import type { Node } from "jsonc-parser";
import type { CoreDiagnostic, ParsedDocument, TextSpan } from "./types.js";

const supportedPcrHashes = new Set(["sha1", "sha256", "sha384", "sha512"]);
const addressRecordTypes = new Set([1, 28]);
const nameRecordTypes = new Set([2, 5, 12, 39]);

export function analyzeSystemdJson(document: ParsedDocument): readonly CoreDiagnostic[] {
  const root = parseTree(document.source, [], {
    allowTrailingComma: false,
    disallowComments: true,
  });
  if (root === undefined) return [];

  const path = decodeURIComponent(document.uri).split(/[?#]/u)[0]?.toLowerCase() ?? "";
  if (path.endsWith(".pcrlock")) return analyzePcrlock(document, root);
  if (path.endsWith(".rr")) return analyzeResourceRecords(document, root);
  return [];
}

function analyzePcrlock(document: ParsedDocument, root: Node): readonly CoreDiagnostic[] {
  const diagnostics: CoreDiagnostic[] = [];
  if (root.type !== "array") {
    addDiagnostic(
      diagnostics,
      document,
      root,
      "invalid-pcrlock-root",
      "A .pcrlock file must contain a CEL-JSON array.",
    );
    return diagnostics;
  }

  for (const record of root.children ?? []) validatePcrlockRecord(document, record, diagnostics);
  return diagnostics;
}

function validatePcrlockRecord(
  document: ParsedDocument,
  record: Node,
  diagnostics: CoreDiagnostic[],
): void {
  if (record.type !== "object") {
    addDiagnostic(
      diagnostics,
      document,
      record,
      "invalid-pcrlock-record",
      "Each .pcrlock array item must be a record object.",
    );
    return;
  }

  const pcr = propertyValue(record, "pcr");
  const nvIndex = propertyValue(record, "nv_index");
  if (pcr === undefined && nvIndex === undefined) {
    addDiagnostic(
      diagnostics,
      document,
      record,
      "pcrlock-index-required",
      "A .pcrlock record requires exactly one of pcr or nv_index.",
    );
  } else if (pcr !== undefined && nvIndex !== undefined) {
    addDiagnostic(
      diagnostics,
      document,
      nvIndex,
      "pcrlock-index-exclusive",
      "A .pcrlock record cannot contain both pcr and nv_index.",
    );
  }
  if (pcr !== undefined && !isIntegerInRange(pcr, 0, 23)) {
    addDiagnostic(
      diagnostics,
      document,
      pcr,
      "invalid-pcrlock-pcr",
      "pcr must be an integer from 0 through 23.",
    );
  }
  if (nvIndex !== undefined && !isIntegerInRange(nvIndex, 0, 4_294_967_294)) {
    addDiagnostic(
      diagnostics,
      document,
      nvIndex,
      "invalid-pcrlock-nv-index",
      "nv_index must be an integer from 0 through 4294967294.",
    );
  }

  const digests = propertyValue(record, "digests");
  if (digests === undefined) {
    addDiagnostic(
      diagnostics,
      document,
      record,
      "pcrlock-digests-required",
      "A .pcrlock record requires a digests array.",
    );
  } else if (digests.type !== "array") {
    addDiagnostic(
      diagnostics,
      document,
      digests,
      "invalid-pcrlock-digests",
      "digests must be an array.",
    );
  } else {
    validatePcrlockDigests(document, digests, diagnostics);
  }

  const contentType = propertyValue(record, "content_type");
  if (contentType !== undefined && stringValue(contentType) === undefined) {
    addDiagnostic(
      diagnostics,
      document,
      contentType,
      "invalid-pcrlock-content-type",
      "content_type must be a string.",
    );
  } else if (stringValue(contentType) === "systemd") {
    validatePcrlockSystemdContent(document, record, diagnostics);
  }
}

function validatePcrlockDigests(
  document: ParsedDocument,
  digests: Node,
  diagnostics: CoreDiagnostic[],
): void {
  const seen = new Set<string>();
  for (const digest of digests.children ?? []) {
    if (digest.type !== "object") {
      addDiagnostic(
        diagnostics,
        document,
        digest,
        "invalid-pcrlock-digest",
        "Each digests item must be an object.",
      );
      continue;
    }
    const hashAlgorithm = propertyValue(digest, "hashAlg");
    const hashName = stringValue(hashAlgorithm);
    if (hashName === undefined) {
      addDiagnostic(
        diagnostics,
        document,
        hashAlgorithm ?? digest,
        "pcrlock-hash-algorithm-required",
        "A digest requires a string hashAlg field.",
      );
      continue;
    }

    const normalizedHash = hashName.toLowerCase();
    if (!supportedPcrHashes.has(normalizedHash)) continue;
    if (seen.has(normalizedHash)) {
      addDiagnostic(
        diagnostics,
        document,
        hashAlgorithm ?? digest,
        "duplicate-pcrlock-hash-algorithm",
        "A .pcrlock record cannot repeat the " + normalizedHash + " digest.",
      );
    }
    seen.add(normalizedHash);

    const encodedDigest = propertyValue(digest, "digest");
    const encoded = stringValue(encodedDigest);
    if (encoded === undefined || !/^(?:[A-Fa-f0-9]{2}){0,64}$/u.test(encoded)) {
      addDiagnostic(
        diagnostics,
        document,
        encodedDigest ?? digest,
        "invalid-pcrlock-digest",
        "digest must be an even-length hexadecimal string of at most 64 bytes.",
      );
    }
  }
}

function validatePcrlockSystemdContent(
  document: ParsedDocument,
  record: Node,
  diagnostics: CoreDiagnostic[],
): void {
  const content = propertyValue(record, "content");
  if (content?.type !== "object") {
    addDiagnostic(
      diagnostics,
      document,
      content ?? record,
      "pcrlock-content-required",
      'content_type "systemd" requires a content object.',
    );
    return;
  }
  for (const field of ["string", "eventType"]) {
    const value = propertyValue(content, field);
    if (value !== undefined && stringValue(value) === undefined) {
      addDiagnostic(
        diagnostics,
        document,
        value,
        "invalid-pcrlock-content",
        "content." + field + " must be a string.",
      );
    }
  }
}

function analyzeResourceRecords(document: ParsedDocument, root: Node): readonly CoreDiagnostic[] {
  const diagnostics: CoreDiagnostic[] = [];
  if (root.type === "object") {
    validateResourceRecord(document, root, diagnostics);
    return diagnostics;
  }
  if (root.type === "array") {
    for (const record of root.children ?? []) {
      validateResourceRecord(document, record, diagnostics);
    }
    return diagnostics;
  }
  addDiagnostic(
    diagnostics,
    document,
    root,
    "invalid-rr-root",
    "A .rr file must contain a DNS record object or an array of record objects.",
  );
  return diagnostics;
}

function validateResourceRecord(
  document: ParsedDocument,
  record: Node,
  diagnostics: CoreDiagnostic[],
): void {
  if (record.type !== "object") {
    addDiagnostic(
      diagnostics,
      document,
      record,
      "invalid-rr-record",
      "Each .rr array item must be a DNS record object.",
    );
    return;
  }

  const key = propertyValue(record, "key");
  if (key?.type !== "object") {
    addDiagnostic(
      diagnostics,
      document,
      key ?? record,
      "rr-key-required",
      "A DNS record requires a key object.",
    );
    return;
  }

  const keyName = propertyValue(key, "name");
  if (!isDnsName(stringValue(keyName))) {
    addDiagnostic(
      diagnostics,
      document,
      keyName ?? key,
      "invalid-rr-name",
      "key.name must be a valid DNS name.",
    );
  }
  const keyClass = propertyValue(key, "class");
  if (keyClass !== undefined && !isIntegerInRange(keyClass, 0, 65_535)) {
    addDiagnostic(
      diagnostics,
      document,
      keyClass,
      "invalid-rr-class",
      "key.class must be an integer from 0 through 65535.",
    );
  }

  const keyType = propertyValue(key, "type");
  const type = integerValue(keyType);
  if (type === undefined || type < 0 || type > 65_535) {
    addDiagnostic(
      diagnostics,
      document,
      keyType ?? key,
      "invalid-rr-type",
      "key.type must be an integer from 0 through 65535.",
    );
    return;
  }
  if (!addressRecordTypes.has(type) && !nameRecordTypes.has(type)) {
    addDiagnostic(
      diagnostics,
      document,
      keyType ?? key,
      "unsupported-rr-type",
      "systemd-resolved currently supports JSON decoding for A, NS, CNAME, PTR, AAAA, and DNAME records only.",
    );
    return;
  }

  if (addressRecordTypes.has(type)) {
    const address = propertyValue(record, "address");
    const valid =
      type === 1 ? isAddress(address, 4, isIpv4Address) : isAddress(address, 16, isIpv6Address);
    if (!valid) {
      addDiagnostic(
        diagnostics,
        document,
        address ?? record,
        "invalid-rr-address",
        type === 1
          ? "An A record requires an IPv4 string or an array of four bytes."
          : "An AAAA record requires an IPv6 string or an array of sixteen bytes.",
      );
    }
    return;
  }

  const targetName = propertyValue(record, "name");
  if (!isDnsName(stringValue(targetName))) {
    addDiagnostic(
      diagnostics,
      document,
      targetName ?? record,
      "invalid-rr-target-name",
      "This DNS record type requires a valid name field.",
    );
  }
}

function propertyValue(object: Node, name: string): Node | undefined {
  if (object.type !== "object") return undefined;
  for (const property of object.children ?? []) {
    const key = property.children?.[0];
    const value = property.children?.[1];
    const keyValue: unknown = key?.value;
    if (keyValue === name) return value;
  }
  return undefined;
}

function stringValue(node: Node | undefined): string | undefined {
  const value: unknown = node?.value;
  return typeof value === "string" ? value : undefined;
}

function integerValue(node: Node | undefined): number | undefined {
  const value: unknown = node?.value;
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function isIntegerInRange(node: Node, minimum: number, maximum: number): boolean {
  const value = integerValue(node);
  return value !== undefined && value >= minimum && value <= maximum;
}

function isAddress(
  node: Node | undefined,
  byteCount: number,
  stringValidator: (value: string) => boolean,
): boolean {
  const encoded = stringValue(node);
  if (encoded !== undefined) return stringValidator(encoded);
  if (node?.type !== "array" || (node.children?.length ?? 0) !== byteCount) return false;
  return (node.children ?? []).every((byte) => isIntegerInRange(byte, 0, 255));
}

function isIpv4Address(value: string): boolean {
  const octets = value.split(".");
  return (
    octets.length === 4 &&
    octets.every((octet) => /^\d{1,3}$/u.test(octet) && Number(octet) >= 0 && Number(octet) <= 255)
  );
}

function isIpv6Address(value: string): boolean {
  if (value === "" || value.includes("%") || /\s/u.test(value)) return false;
  const halves = value.split("::");
  if (halves.length > 2) return false;
  const left = ipv6Words(halves[0] ?? "");
  const right = ipv6Words(halves[1] ?? "");
  if (left === undefined || right === undefined) return false;
  return halves.length === 2 ? left + right < 8 : left === 8;
}

function ipv6Words(value: string): number | undefined {
  if (value === "") return 0;
  const words = value.split(":");
  let count = 0;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? "";
    if (word.includes(".")) {
      if (index !== words.length - 1 || !isIpv4Address(word)) return undefined;
      count += 2;
    } else {
      if (!/^[A-Fa-f0-9]{1,4}$/u.test(word)) return undefined;
      count += 1;
    }
  }
  return count;
}

function isDnsName(value: string | undefined): boolean {
  if (value === undefined || value === "" || value.length > 255 || /[\0-\x20/\x7f]/u.test(value)) {
    return false;
  }
  if (value === "." || value.includes("\\")) return true;
  const normalized = value.endsWith(".") ? value.slice(0, -1) : value;
  return (
    normalized !== "" && normalized.split(".").every((label) => label.length <= 63 && label !== "")
  );
}

function addDiagnostic(
  diagnostics: CoreDiagnostic[],
  document: ParsedDocument,
  node: Node,
  code: string,
  message: string,
): void {
  diagnostics.push({
    code,
    message,
    severity: "error",
    span: nodeSpan(document.source.length, node),
  });
}

function nodeSpan(sourceLength: number, node: Node): TextSpan {
  const start = Math.min(sourceLength, node.offset);
  return {
    start,
    end: Math.min(sourceLength, start + Math.max(1, node.length)),
  };
}
