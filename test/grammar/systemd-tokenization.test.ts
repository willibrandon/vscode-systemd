import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { loadGrammar, tokenAt } from "./tokenize.js";

describe("systemd TextMate grammar regressions", () => {
  it("keeps backslash continuations inside the assignment", async () => {
    const grammar = await loadGrammar("source.systemd");
    const source = [
      "ExecStart=/usr/bin/printf '%s' \\",
      "  first \\   ",
      "  second",
      "Description=done",
    ].join("\n");

    expect(tokenAt(grammar, source, 1, 3).scopes).toContain("meta.assignment.systemd");
    expect(tokenAt(grammar, source, 2, 3).scopes).toContain("meta.assignment.systemd");
    expect(tokenAt(grammar, source, 3, 0).scopes).toContain("support.type.property-name.systemd");
  });

  it("does not inject shell syntax into command values", async () => {
    const grammar = await loadGrammar("source.systemd");
    const source =
      "ExecStart=/bin/sh -c 'data_centers=$(find /srv -name example.sh); echo ${LOCATION-fsn1}'";

    for (const value of ["data_centers", "example.sh", "LOCATION-fsn1"]) {
      const scopes = tokenAt(grammar, source, 0, source.indexOf(value)).scopes;
      expect(scopes, value).toContain("meta.assignment.systemd");
      expect(scopes, value).not.toContain("source.shell");
    }
  });

  it("treats inline hashes and dotted value fragments as literal assignment text", async () => {
    const grammar = await loadGrammar("source.systemd");
    const source = "ExecStart=/usr/bin/example.sh # this is literal\n  # this is a comment";

    expect(tokenAt(grammar, source, 0, source.indexOf(".sh")).scopes).toContain(
      "meta.assignment.systemd",
    );
    expect(tokenAt(grammar, source, 0, source.indexOf("#")).scopes).not.toContain(
      "comment.line.number-sign.systemd",
    );
    expect(tokenAt(grammar, source, 1, 3).scopes).toContain("comment.line.number-sign.systemd");
  });

  it("scopes sections, directive names, booleans, numbers, specifiers, and templates precisely", async () => {
    const grammar = await loadGrammar("source.systemd");
    const source = [
      "[Service]",
      "DynamicUser=yes",
      "TimeoutStartSec=30s",
      "ExecStart=/bin/echo %n",
      "User={{ service_user }}",
    ].join("\n");

    expect(tokenAt(grammar, source, 0, 1).scopes).toContain("entity.name.section.systemd");
    expect(tokenAt(grammar, source, 1, 0).scopes).toContain("support.type.property-name.systemd");
    expect(tokenAt(grammar, source, 1, 12).scopes).toContain("constant.language.boolean.systemd");
    expect(tokenAt(grammar, source, 2, 16).scopes).toContain("constant.numeric.systemd");
    expect(tokenAt(grammar, source, 3, 20).scopes).toContain("variable.other.systemd.specifier");
    expect(tokenAt(grammar, source, 4, 6).scopes).toContain("meta.template.expression.jinja");
  });

  it("tokenizes adversarial command values within the grammar budget", async () => {
    const grammar = await loadGrammar("source.systemd");
    const source = "ExecStart=/bin/echo " + "${VALUE} example.sh # literal ".repeat(5_000);
    const started = performance.now();

    expect(tokenAt(grammar, source, 0, source.length - 2).scopes).toContain(
      "meta.assignment.systemd",
    );
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe("mkosi TextMate grammar regressions", () => {
  it("scopes historical default assignments and their values", async () => {
    const grammar = await loadGrammar("source.mkosi");
    const source = "@WithNetwork=never";

    expect(tokenAt(grammar, source, 0, 0).scopes).toContain("storage.modifier.default.mkosi");
    expect(tokenAt(grammar, source, 0, 1).scopes).toContain("support.type.property-name.systemd");
    expect(tokenAt(grammar, source, 0, source.indexOf("never")).scopes).toContain(
      "constant.language.boolean.systemd",
    );
  });
});

describe("hwdb TextMate grammar regressions", () => {
  it("scopes compiler matches, properties, values, and trailing comments exactly", async () => {
    const grammar = await loadGrammar("source.systemd.hwdb");
    const match = "usb:v0001* # match comment";
    const property = " ID_MODEL=Demo device # value comment";
    const source = [match, property, "\tID_INPUT=1"].join("\n");

    expect(tokenAt(grammar, source, 0, 0).scopes).toContain("entity.name.tag.hwdb");
    expect(tokenAt(grammar, source, 0, match.indexOf("#")).scopes).toContain(
      "comment.line.number-sign.systemd",
    );
    expect(tokenAt(grammar, source, 1, 1).scopes).toContain("support.type.property-name.hwdb");
    expect(tokenAt(grammar, source, 1, property.indexOf("Demo")).scopes).toContain(
      "string.unquoted.hwdb",
    );
    expect(tokenAt(grammar, source, 1, property.lastIndexOf("#")).scopes).toContain(
      "comment.line.number-sign.systemd",
    );
    expect(tokenAt(grammar, source, 2, 1).scopes).not.toContain("meta.assignment.hwdb");
  });
});
