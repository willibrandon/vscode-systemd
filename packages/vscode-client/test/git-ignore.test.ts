import { describe, expect, it } from "vitest";
import { GitIgnoreRules } from "../src/git-ignore.js";

describe("workspace Git ignore rules", () => {
  it("excludes root artifact directories without matching path prefixes", () => {
    const rules = new GitIgnoreRules([{ contents: "artifacts/\n", directory: "" }]);

    expect(rules.ignores("artifacts/tools/emacs.service")).toBe(true);
    expect(rules.ignores("artifacts", true)).toBe(true);
    expect(rules.ignores("artifacts-copy/emacs.service")).toBe(false);
  });

  it("lets a nested ignore file override a file rule inherited from the root", () => {
    const rules = new GitIgnoreRules([
      { contents: "*.service\n", directory: "" },
      { contents: "!emacs.service\n", directory: "units" },
    ]);

    expect(rules.ignores("other.service")).toBe(true);
    expect(rules.ignores("units/other.service")).toBe(true);
    expect(rules.ignores("units/emacs.service")).toBe(false);
  });

  it("does not read a nested ignore file below an excluded parent", () => {
    const rules = new GitIgnoreRules([
      { contents: "artifacts/\n", directory: "" },
      { contents: "!emacs.service\n", directory: "artifacts" },
    ]);

    expect(rules.ignores("artifacts/emacs.service")).toBe(true);
  });

  it("supports anchored patterns, comments, escapes, and Windows separators", () => {
    const rules = new GitIgnoreRules([
      {
        contents: "/root.service\n# comment\n\\#generated.service\n",
        directory: "",
      },
    ]);

    expect(rules.ignores("root.service")).toBe(true);
    expect(rules.ignores("nested/root.service")).toBe(false);
    expect(rules.ignores("#generated.service")).toBe(true);
    expect(rules.ignores("nested\\unit.service")).toBe(false);
  });
});
