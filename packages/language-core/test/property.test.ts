import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { analyze, applyTextEdits, format, parse } from "../src/index.js";
import type { DialectId, SourceSpan, SyntaxNode } from "../src/index.js";

const dialectDocuments = [
  ["systemd-unit", "file:///workspace/property.service"],
  ["systemd-network", "file:///workspace/property.network"],
  ["systemd-config", "file:///workspace/system.conf"],
  ["systemd-tmpfiles", "file:///workspace/tmpfiles.d/property.conf"],
  ["systemd-sysusers", "file:///workspace/sysusers.d/property.conf"],
  ["systemd-udev-rules", "file:///workspace/udev/rules.d/90-property.rules"],
  ["systemd-hwdb", "file:///workspace/udev/hwdb.d/90-property.hwdb"],
  ["systemd-environment", "file:///workspace/environment.d/property.conf"],
  ["systemd-sysctl", "file:///workspace/sysctl.d/property.conf"],
  ["systemd-modules-load", "file:///workspace/modules-load.d/property.conf"],
  ["systemd-binfmt", "file:///workspace/binfmt.d/property.conf"],
  ["systemd-preset", "file:///workspace/system-preset/90-property.preset"],
  ["systemd-table", "file:///workspace/fstab"],
  ["systemd-boot", "file:///workspace/loader/entries/property.conf"],
  ["systemd-dns-trust-anchor", "file:///workspace/property.positive"],
  ["systemd-json", "file:///workspace/property.pcrlock"],
  ["podman-quadlet", "file:///workspace/property.container"],
  ["mkosi", "file:///workspace/mkosi.conf"],
] as const satisfies readonly (readonly [DialectId, string])[];

const adversarialText = fc.oneof(
  fc.string({ maxLength: 2_048 }),
  fc
    .array(
      fc.constantFrom(
        "[",
        "]",
        "=",
        "#",
        ";",
        "\\",
        '"',
        "'",
        "\r",
        "\n",
        "\0",
        "\ud800",
        "{{",
        "}}",
        "%,",
        " ",
      ),
      { maxLength: 512 },
    )
    .map((parts) => parts.join("")),
);

describe("parser and formatter properties", () => {
  it.each(dialectDocuments)("keeps arbitrary %s input total and lossless", (dialect, uri) => {
    fc.assert(
      fc.property(adversarialText, (source) => {
        const document = parse(source, dialect, uri);
        expect(document.source).toBe(source);
        expect(document.dialect).toBe(dialect);
        expect(document.uri).toBe(uri);

        let cursor = 0;
        let rendered = "";
        for (const node of document.nodes) {
          expectSpan(node.span, source.length);
          expect(node.span.start).toBeGreaterThanOrEqual(cursor);
          rendered += source.slice(cursor, node.span.start) + node.raw;
          cursor = node.span.end;
          expectNodeSpans(node, source.length);
        }
        rendered += source.slice(cursor);
        expect(rendered).toBe(source);

        for (const diagnostic of [...document.diagnostics, ...analyze(document)]) {
          expectSpan(diagnostic.span, source.length);
        }

        const edits = format(document);
        let previousStart = source.length + 1;
        for (const edit of [...edits].sort((left, right) => right.span.start - left.span.start)) {
          expectSpan(edit.span, source.length);
          expect(edit.span.end).toBeLessThanOrEqual(previousStart);
          previousStart = edit.span.start;
        }
        const formatted = applyTextEdits(source, edits);
        expect(format(parse(formatted, dialect, uri))).toEqual([]);
      }),
      { numRuns: 100, seed: 0x5a17e0d },
    );
  });
});

function expectNodeSpans(node: SyntaxNode, sourceLength: number): void {
  if (node.kind === "section") expectSpan(node.nameSpan, sourceLength);
  if (node.kind === "assignment") {
    expectSpan(node.nameSpan, sourceLength);
    expectSpan(node.valueSpan, sourceLength);
  }
  if (node.kind === "record") {
    for (const span of node.fieldSpans) expectSpan(span, sourceLength);
  }
}

function expectSpan(span: SourceSpan, sourceLength: number): void {
  expect(Number.isInteger(span.start)).toBe(true);
  expect(Number.isInteger(span.end)).toBe(true);
  expect(span.start).toBeGreaterThanOrEqual(0);
  expect(span.end).toBeGreaterThanOrEqual(span.start);
  expect(span.end).toBeLessThanOrEqual(sourceLength);
}
