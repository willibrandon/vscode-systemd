import { minimatch } from "minimatch";
import { describe, expect, it } from "vitest";
import {
  exactDialectAssociationPattern,
  withDialectAssociation,
} from "../src/dialect-associations.js";

describe("persistent dialect associations", () => {
  it("stores the narrowest workspace-relative exact path", () => {
    const pattern = exactDialectAssociationPattern(
      "/work/project/config/[production]/override.conf",
      "/work/project",
    );

    expect(minimatch("config/[production]/override.conf", pattern)).toBe(true);
    expect(minimatch("config/p/override.conf", pattern)).toBe(false);
    expect(pattern).not.toContain("/work/project");
  });

  it("uses an exact absolute path outside a workspace and preserves sibling overrides", () => {
    const pattern = exactDialectAssociationPattern("/etc/custom/example.conf");
    const associations = withDialectAssociation(
      { "deploy/*.conf": "systemd-network" },
      pattern,
      "systemd-config",
    );

    expect(associations).toEqual({
      "deploy/*.conf": "systemd-network",
      "etc/custom/example.conf": "systemd-config",
    });
  });
});
