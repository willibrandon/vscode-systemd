import { describe, expect, it } from "vitest";
import {
  mergeConfigurations,
  parse,
  renderEffectiveConfiguration,
  resolveConfigurationDocuments,
} from "../src/index.js";
import type { ParsedDocument } from "../src/index.js";

function unit(uri: string, source = "[Unit]\nDescription=" + uri + "\n"): ParsedDocument {
  return parse(source, "systemd-unit", uri);
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
