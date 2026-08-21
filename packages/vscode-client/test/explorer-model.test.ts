import { describe, expect, it } from "vitest";
import type { WorkspaceSnapshotConfiguration } from "@systemd/language-server/protocol";
import { collectConfigurations, configurationTooltip } from "../src/explorer-model.js";

const configuration = (
  identity: string,
  overrides: Partial<WorkspaceSnapshotConfiguration> = {},
): WorkspaceSnapshotConfiguration => ({
  identity,
  languageId: "systemd-unit",
  sourceUri: "file:///workspace/" + identity,
  baseUri: "file:///usr/lib/systemd/system/" + identity,
  dropInUris: [],
  documentUris: ["file:///usr/lib/systemd/system/" + identity],
  masked: false,
  ...overrides,
});

describe("Systemd Explorer model", () => {
  it("groups templates and their instances without flattening ordinary units", () => {
    const collections = collectConfigurations([
      configuration("worker@green.service"),
      configuration("plain.service"),
      configuration("worker@.service"),
      configuration("worker@blue.service"),
      configuration("build@nightly.container", { languageId: "podman-quadlet" }),
    ]);

    expect(collections.map(({ label }) => label)).toEqual([
      "build@.container",
      "plain.service",
      "worker@.service",
    ]);
    expect(collections[0]?.template).toBe(true);
    expect(collections[1]?.template).toBe(false);
    expect(collections[2]?.configurations.map(({ identity }) => identity)).toEqual([
      "worker@.service",
      "worker@blue.service",
      "worker@green.service",
    ]);
  });

  it("shows status, precedence, candidates, and reference counts in configuration hover", () => {
    const item = configuration("worker@green.service", {
      sourceUri: "file:///etc/systemd/system/worker@green.service.d/override.conf",
      baseUri: "file:///usr/lib/systemd/system/worker@.service",
      dropInUris: ["file:///etc/systemd/system/worker@green.service.d/override.conf"],
      documentUris: [
        "file:///usr/lib/systemd/system/worker@.service",
        "file:///etc/systemd/system/worker@green.service.d/override.conf",
        "file:///workspace/worker@green.service.ignore",
      ],
    });

    expect(configurationTooltip(item, 3, 2)).toBe(
      [
        "worker@green.service",
        "Language: systemd-unit",
        "Status: active",
        "Source: file:///etc/systemd/system/worker@green.service.d/override.conf",
        "Base: file:///usr/lib/systemd/system/worker@.service",
        "Drop-ins: 1",
        "Other candidates: 1",
        "References: 3 outgoing, 2 incoming",
      ].join("\n"),
    );
  });

  it("makes masked and fragmentless configurations explicit", () => {
    const item: WorkspaceSnapshotConfiguration = {
      identity: "masked.service",
      languageId: "systemd-unit",
      sourceUri: "file:///etc/systemd/system/masked.service",
      documentUris: [],
      dropInUris: [],
      masked: true,
    };

    expect(configurationTooltip(item, 0, 0)).toContain("Status: masked");
    expect(configurationTooltip(item, 0, 0)).toContain("Base: none");
  });
});
