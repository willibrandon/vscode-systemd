import { describe, expect, it } from "vitest";
import type {
  WorkspaceSnapshot,
  WorkspaceSnapshotConfiguration,
} from "@systemd/language-server/protocol";
import {
  collectConfigurations,
  collectConfigurationScopes,
  configurationTooltip,
  indexedSourceUri,
} from "../src/explorer-model.js";

const configuration = (
  identity: string,
  overrides: Partial<WorkspaceSnapshotConfiguration> = {},
): WorkspaceSnapshotConfiguration => ({
  identity,
  languageId: "systemd-unit",
  sourceUri: "file:///workspace/" + identity,
  workspaceOwned: true,
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
      workspaceOwned: true,
      documentUris: [],
      dropInUris: [],
      masked: true,
    };

    expect(configurationTooltip(item, 0, 0)).toContain("Status: masked");
    expect(configurationTooltip(item, 0, 0)).toContain("Base: none");
  });

  it("opens an indexed configuration at the effective base file", () => {
    const snapshot: WorkspaceSnapshot = {
      configurations: [
        configuration("prometheus.service", {
          sourceUri: "file:///workspace/prometheus.service.d/override.conf",
          baseUri: "file:///usr/lib/systemd/system/prometheus.service",
        }),
      ],
      documents: [],
    };

    expect(indexedSourceUri(snapshot, "prometheus.service")).toBe(
      "file:///usr/lib/systemd/system/prometheus.service",
    );
  });

  it("falls back to an indexed configuration source when no base file exists", () => {
    const snapshot: WorkspaceSnapshot = {
      configurations: [
        {
          identity: "local.service",
          languageId: "systemd-unit",
          sourceUri: "file:///workspace/local.service",
          workspaceOwned: true,
          dropInUris: [],
          documentUris: ["file:///workspace/local.service"],
          masked: false,
        },
      ],
      documents: [],
    };

    expect(indexedSourceUri(snapshot, "local.service")).toBe("file:///workspace/local.service");
  });

  it("resolves an indexed document that is not an effective configuration", () => {
    const snapshot: WorkspaceSnapshot = {
      configurations: [],
      documents: [
        {
          uri: "file:///workspace/network.network",
          identity: "network.network",
          languageId: "systemd-network",
          workspaceOwned: true,
          references: [],
        },
      ],
    };

    expect(indexedSourceUri(snapshot, "network.network")).toBe("file:///workspace/network.network");
  });

  it("does not invent a source for a valid reference that is unavailable on this host", () => {
    const snapshot: WorkspaceSnapshot = { configurations: [], documents: [] };

    expect(indexedSourceUri(snapshot, "timers.target")).toBeUndefined();
    expect(indexedSourceUri(snapshot, "prometheus.service")).toBeUndefined();
  });

  it("puts workspace configurations before host configurations", () => {
    const scopes = collectConfigurationScopes([
      configuration("system.service", {
        sourceUri: "file:///usr/lib/systemd/system/system.service",
        workspaceOwned: false,
      }),
      configuration("dotsider-website.service"),
      configuration("caddy-report.timer"),
    ]);

    expect(scopes.map(({ label }) => label)).toEqual(["Workspace", "Host"]);
    expect(scopes[0]?.configurations.map(({ identity }) => identity)).toEqual([
      "caddy-report.timer",
      "dotsider-website.service",
    ]);
    expect(scopes[1]?.configurations.map(({ identity }) => identity)).toEqual(["system.service"]);
  });
});
