import type { AssignmentNode, FormatOptions, ParsedDocument, TextEdit } from "./types.js";

export function format(
  document: ParsedDocument,
  options: FormatOptions = {
    insertSpaces: true,
    tabSize: 4,
    trimTrailingWhitespace: true,
  },
): readonly TextEdit[] {
  const lineEnding = document.source.includes("\r\n") ? "\r\n" : "\n";
  const selected = options.range;
  const edits: TextEdit[] = [];
  for (const node of document.nodes) {
    if (
      selected !== undefined &&
      (node.span.end < selected.start || node.span.start > selected.end)
    ) {
      continue;
    }
    let replacement = node.raw;
    if (node.kind === "assignment" && !node.raw.includes("\n")) {
      replacement = assignmentText(node);
    } else if (node.kind === "section") {
      replacement = "[" + node.name + "]";
    } else if (
      node.kind === "record" &&
      ["systemd-tmpfiles", "systemd-sysusers", "systemd-table"].includes(document.dialect)
    ) {
      replacement = node.fields.join(" ");
    }
    if (options.trimTrailingWhitespace) {
      replacement = replacement
        .split(/\r?\n/u)
        .map((line) => line.trimEnd())
        .join(lineEnding);
    }
    if (replacement !== node.raw) edits.push({ span: node.span, newText: replacement });
  }
  return edits;
}

export function applyTextEdits(source: string, edits: readonly TextEdit[]): string {
  let result = source;
  for (const edit of [...edits].sort((a, b) => b.span.start - a.span.start)) {
    result = result.slice(0, edit.span.start) + edit.newText + result.slice(edit.span.end);
  }
  return result;
}

function assignmentText(node: AssignmentNode): string {
  return node.name + "=" + node.value;
}
