import { describe, expect, it } from "vitest";
import {
  findOrderingDependencyCycles,
  mergeConfigurations,
  parse,
  renderEffectiveConfiguration,
  resolveConfigurationDocuments,
} from "../src/index.js";
import type { ParsedDocument } from "../src/index.js";

function unit(uri: string, source = "[Unit]\nDescription=" + uri + "\n"): ParsedDocument {
  return parse(source, "systemd-unit", uri);
}

function alias(uri: string, canonicalUri: string, source: string): ParsedDocument {
  return { ...unit(uri, source), canonicalUri };
}

describe("systemd unit configuration resolution", () => {
  it("selects the highest-priority main unit from the system lookup path", () => {
    const vendor = unit("file:///usr/lib/systemd/system/demo.service");
    const runtime = unit("file:///run/systemd/system/demo.service");
    const administrator = unit("file:///etc/systemd/system/demo.service");

    const resolution = resolveConfigurationDocuments(administrator.uri, [
      administrator,
      vendor,
      runtime,
    ]);

    expect(resolution).toMatchObject({
      identity: "demo.service",
      baseUri: administrator.uri,
      dropInUris: [],
      masked: false,
    });
    expect(resolution.documents.map(({ uri }) => uri)).toEqual([administrator.uri]);
  });

  it("falls back to a template main unit and prefers a concrete instance", () => {
    const template = unit("file:///usr/lib/systemd/system/worker@.service");
    const instance = unit("file:///run/systemd/system/worker@blue.service");

    expect(
      resolveConfigurationDocuments("file:///etc/systemd/system/worker@green.service", [template])
        .baseUri,
    ).toBe(template.uri);
    expect(resolveConfigurationDocuments(instance.uri, [template, instance]).baseUri).toBe(
      instance.uri,
    );
  });

  it("honors instance, template, dash-prefix, type-wide, and lookup-path precedence", () => {
    const base = unit("file:///usr/lib/systemd/system/foo-bar@.service");
    const vendorType = unit(
      "file:///usr/lib/systemd/system/service.d/10-default.conf",
      "[Service]\nEnvironment=VENDOR=1\n",
    );
    const runtimeExact = unit(
      "file:///run/systemd/system/foo-bar@blue.service.d/10-default.conf",
      "[Service]\nEnvironment=RUNTIME=1\n",
    );
    const administratorType = unit(
      "file:///etc/systemd/system/service.d/10-default.conf",
      "[Service]\nEnvironment=ADMIN=1\n",
    );
    const template = unit(
      "file:///etc/systemd/system/foo-bar@.service.d/20-shared.conf",
      "[Service]\nEnvironment=TEMPLATE=1\n",
    );
    const exact = unit(
      "file:///etc/systemd/system/foo-bar@blue.service.d/20-shared.conf",
      "[Service]\nEnvironment=EXACT=1\n",
    );
    const plainPrefix = unit(
      "file:///etc/systemd/system/foo-.service.d/30-plain-prefix.conf",
      "[Service]\nEnvironment=PLAIN_PREFIX=1\n",
    );
    const instancePrefix = unit(
      "file:///etc/systemd/system/foo-@blue.service.d/40-instance-prefix.conf",
      "[Service]\nEnvironment=INSTANCE_PREFIX=1\n",
    );
    const templatePrefix = unit(
      "file:///etc/systemd/system/foo-@.service.d/50-template-prefix.conf",
      "[Service]\nEnvironment=TEMPLATE_PREFIX=1\n",
    );

    const resolution = resolveConfigurationDocuments("file:///workspace/foo-bar@blue.service", [
      runtimeExact,
      exact,
      templatePrefix,
      base,
      vendorType,
      instancePrefix,
      administratorType,
      plainPrefix,
      template,
    ]);

    expect(resolution.documents.map(({ uri }) => uri)).toEqual([
      base.uri,
      administratorType.uri,
      exact.uri,
      plainPrefix.uri,
      instancePrefix.uri,
      templatePrefix.uri,
    ]);
    const rendered = renderEffectiveConfiguration(mergeConfigurations(resolution.documents));
    expect(rendered).toContain("Environment=ADMIN=1");
    expect(rendered).toContain("Environment=EXACT=1");
    expect(rendered).not.toContain("VENDOR=1");
    expect(rendered).not.toContain("RUNTIME=1");
    expect(rendered).not.toContain("TEMPLATE=1");
  });

  it("treats an empty highest-priority main file as a mask", () => {
    const vendor = unit("file:///usr/lib/systemd/system/masked.service");
    const dropIn = unit(
      "file:///etc/systemd/system/masked.service.d/override.conf",
      "[Service]\nEnvironment=SHOULD_NOT_APPLY=1\n",
    );
    const mask = unit("file:///etc/systemd/system/masked.service", "");

    const resolution = resolveConfigurationDocuments(mask.uri, [vendor, dropIn, mask]);

    expect(resolution.masked).toBe(true);
    expect(resolution.documents).toEqual([mask]);
    expect(resolution.dropInUris).toEqual([]);
  });

  it("resolves unit aliases to their canonical base and combines both drop-in names", () => {
    const canonical = unit(
      "file:///usr/lib/systemd/system/real.service",
      "[Unit]\nDescription=Canonical\n",
    );
    const unitAlias = alias(
      "file:///etc/systemd/system/alias.service",
      canonical.uri,
      canonical.source,
    );
    const canonicalDropIn = unit(
      "file:///etc/systemd/system/real.service.d/10-canonical.conf",
      "[Service]\nEnvironment=CANONICAL=1\n",
    );
    const aliasDropIn = unit(
      "file:///etc/systemd/system/alias.service.d/20-alias.conf",
      "[Service]\nEnvironment=ALIAS=1\n",
    );
    const documents = [unitAlias, aliasDropIn, canonicalDropIn, canonical];

    for (const uri of [unitAlias.uri, canonical.uri]) {
      const resolution = resolveConfigurationDocuments(uri, documents);
      expect(resolution.baseUri).toBe(canonical.uri);
      expect(resolution.dropInUris).toEqual([canonicalDropIn.uri, aliasDropIn.uri]);
      const rendered = renderEffectiveConfiguration(mergeConfigurations(resolution.documents));
      expect(rendered).toContain("Environment=CANONICAL=1");
      expect(rendered).toContain("Environment=ALIAS=1");
    }
  });

  it("treats a symlink to a non-unit empty target as a mask", () => {
    const vendor = unit("file:///usr/lib/systemd/system/disabled.service");
    const mask = alias("file:///etc/systemd/system/disabled.service", "file:///dev/null", "");

    const resolution = resolveConfigurationDocuments(mask.uri, [vendor, mask]);

    expect(resolution.masked).toBe(true);
    expect(resolution.baseUri).toBe(mask.uri);
    expect(resolution.documents).toEqual([mask]);
  });

  it("previews only the queried working copy without contaminating normal resolution", () => {
    const base = unit("file:///workspace/preview.service");
    const active = unit(
      "file:///workspace/preview.service.d/override.conf",
      "[Service]\nEnvironment=ACTIVE=1\n",
    );
    const ignored = unit(
      "file:///workspace/preview.service.d/override.conf.ignore",
      "[Service]\nEnvironment=PREVIEW=1\n",
    );
    const unrelatedIgnored = unit(
      "file:///workspace/preview.service.d/other.conf.ignore",
      "[Service]\nEnvironment=UNRELATED=1\n",
    );

    expect(
      resolveConfigurationDocuments(base.uri, [base, active, ignored, unrelatedIgnored]).dropInUris,
    ).toEqual([active.uri]);
    expect(
      resolveConfigurationDocuments(ignored.uri, [base, active, ignored, unrelatedIgnored])
        .dropInUris,
    ).toEqual([ignored.uri]);
  });
});

describe("systemd ordering dependency graph", () => {
  it("finds multi-unit and self cycles with source provenance", () => {
    const first = unit(
      "file:///workspace/first.service",
      "[Unit]\nAfter=second.service\n[Service]\nExecStart=/bin/true\n",
    );
    const second = unit(
      "file:///workspace/second.service",
      "[Unit]\nAfter=third.service\n[Service]\nExecStart=/bin/true\n",
    );
    const third = unit(
      "file:///workspace/third.service",
      "[Unit]\nAfter=first.service\n[Service]\nExecStart=/bin/true\n",
    );
    const self = unit(
      "file:///workspace/self.service",
      "[Unit]\nBefore=self.service\n[Service]\nExecStart=/bin/true\n",
    );

    const cycles = findOrderingDependencyCycles([third, self, first, second]);

    expect(cycles.map(({ nodes }) => nodes)).toEqual([
      ["first.service", "second.service", "third.service"],
      ["self.service"],
    ]);
    expect(cycles[0]?.edges).toHaveLength(3);
    expect(cycles[0]?.edges.map(({ sourceUri }) => sourceUri)).toEqual(
      expect.arrayContaining([first.uri, second.uri, third.uri]),
    );
    const firstEdge = cycles[0]?.edges.find(({ sourceUri }) => sourceUri === first.uri);
    expect(first.source.slice(firstEdge?.span.start, firstEdge?.span.end)).toBe("second.service");
  });

  it("keeps dependencies after an empty no-op assignment", () => {
    const first = unit(
      "file:///workspace/reset-a.service",
      "[Unit]\nAfter=reset-b.service\nRequires=reset-b.service\n",
    );
    const reset = unit("file:///workspace/reset-a.service.d/override.conf", "[Unit]\nAfter=\n");
    const second = unit(
      "file:///workspace/reset-b.service",
      "[Unit]\nAfter=reset-a.service\nRequires=reset-a.service\n",
    );

    const cycles = findOrderingDependencyCycles([first, reset, second]);

    expect(cycles).toHaveLength(1);
    expect(cycles[0]?.nodes).toEqual(["reset-a.service", "reset-b.service"]);
    expect(cycles[0]?.edges.map(({ directive }) => directive)).toEqual(["After", "After"]);
  });
});
