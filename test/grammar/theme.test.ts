import { describe, expect, it } from "vitest";
import type { IRawTheme } from "vscode-textmate";
import { themedTokenAt } from "./tokenize.js";

const grammarCases = [
  ["source.systemd", "[Service]", 0, 1, "entity.name.section.systemd"],
  ["source.systemd.network", "[Network]\nDHCP=yes", 1, 0, "support.type.property-name.systemd"],
  [
    "source.systemd.config",
    "[Journal]\nStorage=persistent",
    1,
    0,
    "support.type.property-name.systemd",
  ],
  [
    "source.podman.quadlet",
    "[Container]\nImage=quay.io/example/app",
    1,
    0,
    "support.type.property-name.systemd",
  ],
  ["source.mkosi", "@WithNetwork=never", 0, 0, "storage.modifier.default.mkosi"],
  ["source.systemd.udev", 'ACTION=="add"', 0, 6, "keyword.operator.udev"],
  ["source.systemd.hwdb", " ID_MODEL=Demo", 0, 1, "support.type.property-name.hwdb"],
  ["source.systemd.json", '{"records":true}', 0, 1, "string.quoted.double.json"],
  ["source.systemd.records", "Enabled=yes", 0, 8, "string.unquoted.systemd"],
  [
    "source.systemd.markdown",
    "```systemd\n[Service]\nExecStart=/bin/true\n```",
    2,
    0,
    "support.type.property-name.systemd",
  ],
] as const;

const themes = [
  ["light", "#1F2328", "#0550AE", "#FFFFFF"],
  ["dark", "#E6EDF3", "#79C0FF", "#0D1117"],
  ["high contrast", "#FFFFFF", "#FFFF00", "#000000"],
] as const;

describe("contributed TextMate grammars and theme classes", () => {
  it.each(themes)(
    "loads and resolves every contributed grammar in the %s theme",
    async (_name, foreground, accent, background) => {
      for (const [scopeName, source, line, character, expectedScope] of grammarCases) {
        const token = await themedTokenAt(
          scopeName,
          source,
          line,
          character,
          theme(scopeName, foreground, accent, background),
        );
        expect(token.scopes, scopeName).toContain(expectedScope);
        expect(token.foreground, scopeName).toBe(accent);
      }
    },
  );
});

function theme(
  scopeName: string,
  foreground: string,
  accent: string,
  background: string,
): IRawTheme {
  return {
    settings: [
      { settings: { foreground, background } },
      { scope: scopeName, settings: { foreground: accent } },
    ],
  };
}
