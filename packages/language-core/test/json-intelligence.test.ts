import { describe, expect, it } from "vitest";
import {
  applyTextEdits,
  format,
  parseUserDbMetadata,
  parse,
  systemdJsonFieldContext,
  systemdJsonFieldsFor,
  systemdJsonFoldingSpans,
  systemdJsonOutline,
  systemdJsonPropertyContext,
  systemdJsonSelectionSpans,
  systemdJsonSemanticSpans,
  systemdJsonValueContext,
  userDbDefinition,
  userDbFieldFor,
} from "../src/index.js";

describe("systemd JSON editor intelligence", () => {
  it("offers every non-sensitive public user record field", () => {
    const fields = systemdJsonFieldsFor("systemd-json:user", []);
    expect(fields.length).toBeGreaterThan(90);
    expect(fields.find(({ name }) => name === "userName")).toMatchObject({
      required: true,
      types: ["string"],
    });
    expect(fields.map(({ name }) => name)).not.toContain("secret");
    expect(fields.map(({ name }) => name)).not.toContain("privileged");
  });

  it("exposes the generated userdb records and fields through typed accessors", () => {
    expect(userDbDefinition("group").required).toEqual(["groupName"]);
    expect(userDbFieldFor("user", "uid")).toMatchObject({
      name: "uid",
      types: ["integer"],
      minimum: 0,
    });
    expect(userDbFieldFor("group", "notAField")).toBeUndefined();
  });

  it("rejects malformed bundled userdb metadata", () => {
    expect(() => parseUserDbMetadata(null)).toThrow("must be an object");
    expect(() =>
      parseUserDbMetadata({ schemaVersion: 2, upstream: "bad", user: {}, group: {} }),
    ).toThrow("is invalid");
    expect(
      parseUserDbMetadata({
        schemaVersion: 1,
        upstream: "a".repeat(40),
        user: {
          documentation: "https://example.test/user",
          required: ["userName"],
          fields: [{ name: "userName", types: ["string"], description: "User name." }],
        },
        group: {
          documentation: "https://example.test/group",
          required: ["groupName"],
          fields: [{ name: "groupName", types: ["string"], description: "Group name." }],
        },
      }),
    ).toMatchObject({ schemaVersion: 1, upstream: "a".repeat(40) });
  });

  it("omits properties already present in an object", () => {
    const source = '{\n  "userName": "demo",\n  \n}\n';
    const context = systemdJsonPropertyContext(
      source,
      "systemd-json:user",
      source.lastIndexOf("  \n") + 2,
    );
    expect(context?.fields.map(({ name }) => name)).not.toContain("userName");
    expect(context?.fields.map(({ name }) => name)).toContain("uid");
  });

  it("resolves nested PCR and DNS record objects", () => {
    expect(systemdJsonFieldsFor("systemd-json:pcrlock", [0]).map(({ name }) => name)).toEqual([
      "pcr",
      "nv_index",
      "digests",
      "content_type",
      "content",
    ]);
    expect(
      systemdJsonFieldsFor("systemd-json:pcrlock", [0, "digests", 0]).map(({ name }) => name),
    ).toEqual(["hashAlg", "digest"]);
    expect(systemdJsonFieldsFor("systemd-json:rr", [0, "key"])).toContainEqual(
      expect.objectContaining({ name: "type", choices: [1, 2, 5, 12, 28, 39] }),
    );
  });

  it("provides value choices and exact quoted replacement spans", () => {
    const source = '{"disposition": "dyn"}';
    const context = systemdJsonValueContext(source, "systemd-json:user", source.indexOf("dyn") + 2);
    expect(context).toMatchObject({
      arrayItem: false,
      quoted: true,
      field: { name: "disposition" },
    });
    expect(context?.field.choices).toEqual(expect.arrayContaining(["dynamic", "regular"]));
    expect(source.slice(context?.replaceSpan?.start, context?.replaceSpan?.end)).toBe("dyn");
  });

  it("provides unquoted booleans and array-item choices", () => {
    const booleanSource = '{"locked": }';
    expect(
      systemdJsonValueContext(booleanSource, "systemd-json:user", booleanSource.indexOf("}")),
    ).toMatchObject({ field: { name: "locked", types: ["boolean"] }, quoted: false });

    const arraySource = '{"recoveryKeyType": [""]}';
    expect(
      systemdJsonValueContext(arraySource, "systemd-json:user", arraySource.indexOf('""') + 1),
    ).toMatchObject({
      field: { name: "recoveryKeyType", itemChoices: ["modhex64"] },
      arrayItem: true,
      quoted: true,
    });
  });

  it("returns no value help outside known JSON properties", () => {
    expect(systemdJsonValueContext("[]", "systemd-unit:service", 1)).toBeUndefined();
    expect(systemdJsonValueContext("", "systemd-json:user", 0)).toBeUndefined();
    expect(systemdJsonValueContext('{"future": }', "systemd-json:user", 11)).toBeUndefined();
    expect(systemdJsonValueContext("[ ]", "systemd-json:pcrlock", 1)).toBeUndefined();
  });

  it("identifies a known property from either its key or value", () => {
    const source = '{"userName": "demo"}';
    expect(systemdJsonFieldContext(source, "systemd-json:user", 3)).toMatchObject({
      field: { name: "userName", required: true },
    });
    expect(systemdJsonFieldContext(source, "systemd-json:user", 15)).toMatchObject({
      field: { name: "userName", required: true },
      span: { start: 1, end: 11 },
    });
  });

  it("returns no hover for malformed, unknown, or non-JSON selections", () => {
    expect(systemdJsonFieldContext("{}", "systemd-unit:service", 0)).toBeUndefined();
    expect(systemdJsonFieldContext("", "systemd-json:user", 0)).toBeUndefined();
    expect(systemdJsonFieldContext("{}", "systemd-json:user", 0)).toBeUndefined();
    expect(systemdJsonFieldContext('{"future": 1}', "systemd-json:user", 3)).toBeUndefined();
  });

  it("covers empty and nested object property contexts", () => {
    expect(systemdJsonPropertyContext("", "systemd-unit:service", 0)).toBeUndefined();
    expect(systemdJsonPropertyContext("", "systemd-json:user", 0)).toBeUndefined();
    expect(systemdJsonPropertyContext("{\n  \n}", "systemd-json:membership", 4)).toEqual({
      fields: [],
      prefix: "",
    });
    expect(
      systemdJsonPropertyContext('[{"content": {\n  \n}}]', "systemd-json:pcrlock", 16)?.fields.map(
        ({ name }) => name,
      ),
    ).toEqual(["string", "eventType"]);
  });

  it("returns fields only for supported object paths", () => {
    expect(systemdJsonFieldsFor("systemd-json:user", ["nested"])).toEqual([]);
    expect(systemdJsonFieldsFor("systemd-json:group", []).length).toBeGreaterThan(10);
    expect(systemdJsonFieldsFor("systemd-json:pcrlock", [])).toEqual([]);
    expect(systemdJsonFieldsFor("systemd-json:rr", []).map(({ name }) => name)).toEqual([
      "key",
      "address",
      "name",
    ]);
    expect(systemdJsonFieldsFor("systemd-json:rr", ["key"]).map(({ name }) => name)).toEqual([
      "class",
      "type",
      "name",
    ]);
    expect(systemdJsonFieldsFor("systemd-json:membership", [])).toEqual([]);
  });

  it("builds nested outline, folding, selection, and semantic structures", () => {
    const source = [
      "{",
      '  "userName": "demo",',
      '  "uid": 1000,',
      '  "locked": true,',
      '  "future": null,',
      '  "environment": ["A=B"],',
      '  "status": {"machine": "ready"}',
      "}",
    ].join("\n");
    const outline = systemdJsonOutline(source);
    expect(outline.map(({ name, type }) => [name, type])).toEqual([
      ["userName", "string"],
      ["uid", "number"],
      ["locked", "boolean"],
      ["future", "null"],
      ["environment", "array"],
      ["status", "object"],
    ]);
    expect(outline[4]?.children).toMatchObject([{ name: "[0]", type: "string" }]);
    expect(outline[5]?.children).toMatchObject([{ name: "machine", type: "string" }]);
    expect(systemdJsonFoldingSpans(source).length).toBe(3);

    const selections = systemdJsonSelectionSpans(source, source.indexOf("demo") + 1);
    expect(selections.length).toBeGreaterThanOrEqual(3);
    expect(
      selections
        .slice(1)
        .every((span, index) =>
          selections[index] === undefined ? false : span.start <= selections[index].start,
        ),
    ).toBe(true);

    const semantics = systemdJsonSemanticSpans(source);
    expect(new Set(semantics.map(({ type }) => type))).toEqual(
      new Set(["property", "string", "number", "keyword"]),
    );
  });

  it("formats strict systemd JSON with editor indentation options", () => {
    const source = '{"userName":"demo","status":{"ready":true}}\n';
    const document = parse(source, "systemd-json", "file:///workspace/demo.user");
    const edits = format(document, {
      insertSpaces: true,
      tabSize: 2,
      trimTrailingWhitespace: true,
    });
    const formatted = applyTextEdits(source, edits);
    expect(formatted).toBe(
      ["{", '  "userName": "demo",', '  "status": {', '    "ready": true', "  }", "}", ""].join(
        "\n",
      ),
    );
    expect(
      format(parse(formatted, "systemd-json", "file:///workspace/demo.user"), {
        insertSpaces: true,
        tabSize: 2,
        trimTrailingWhitespace: true,
      }),
    ).toEqual([]);
  });

  it("returns empty structure data for malformed empty JSON", () => {
    expect(systemdJsonOutline("")).toEqual([]);
    expect(systemdJsonFoldingSpans("")).toEqual([]);
    expect(systemdJsonSelectionSpans("", 0)).toEqual([]);
    expect(systemdJsonSemanticSpans("")).toEqual([]);
  });
});
