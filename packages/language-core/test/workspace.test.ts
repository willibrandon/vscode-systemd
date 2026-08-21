import { describe, expect, it } from "vitest";
import {
  analyzeWorkspaceReferences,
  buildReferenceGraph,
  buildSemanticModel,
  extractReferences,
  findOrderingDependencyCycles,
  mergeConfigurations,
  parse,
  mkosiIncludePath,
  relativeMkosiPath,
  renderEffectiveConfiguration,
  resolveConfigurationDocuments,
  resolveMkosiConfiguration,
  resolveMkosiReferenceDocuments,
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

describe("configuration merging", () => {
  it("lets explicit mkosi assignments override historical defaults in either order", () => {
    for (const source of [
      "[Output]\n@Format=directory\nFormat=disk\n",
      "[Output]\nFormat=disk\n@Format=directory\n",
    ]) {
      expect(
        mergeConfigurations([parse(source, "mkosi", "file:///workspace/mkosi.conf")]).entries,
      ).toMatchObject([{ section: "Output", name: "Format", value: "disk" }]);
    }
    expect(
      mergeConfigurations([
        parse("[Output]\n@Format=directory\n", "mkosi", "file:///workspace/mkosi.conf"),
      ]).entries,
    ).toMatchObject([{ section: "Output", name: "Format", value: "directory" }]);
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

describe("typed semantic and reference models", () => {
  it("builds a lossless semantic view and a deterministic cross-file graph", () => {
    const first = unit(
      "file:///workspace/first.service",
      "[Unit]\nWants=second.service\n[Service]\nExecStart=/bin/true\n",
    );
    const second = unit("file:///workspace/second.service");

    const model = buildSemanticModel(first);
    expect(model.document).toBe(first);
    expect(model.sections.map(({ name }) => name)).toEqual(["Unit", "Service"]);
    expect(model.assignments.map(({ name }) => name)).toEqual(["Wants", "ExecStart"]);
    expect(model.references.map(({ target }) => target)).toEqual(["second.service"]);

    const graph = buildReferenceGraph([second, first]);
    expect(graph.nodes).toEqual([
      { identity: "first.service", sourceUris: [first.uri] },
      { identity: "second.service", sourceUris: [second.uri] },
    ]);
    expect(graph.edges).toMatchObject([
      {
        source: "first.service",
        target: "second.service",
        kind: "unit",
        sourceUri: first.uri,
      },
    ]);
  });

  it("extracts only real Quadlet references and preserves structured source spans", () => {
    const source = [
      "[Unit]",
      "After=database.container network-online.target",
      "[Container]",
      "Image=quay.io/example/application:latest",
      "Network=backend.network:interface_name=eth0",
      "Network=none",
      "Pod=application.pod",
      "Volume=data.volume:/var/lib/data:Z",
      "Volume=/srv/cache:/cache:ro",
      "Mount=type=image,source=base.image,target=/opt/base",
      'Mount="type=image","source=archive,base.image",target=/opt/archive',
      "Mount=type=tmpfs,source=ignored.image,target=/run/cache",
      "Mount=type=image,source=first.image,src=last.image,target=/opt/last",
      "ImageVolume=bind",
      "",
    ].join("\n");
    const document = parse(source, "podman-quadlet", "file:///workspace/application.container");
    const references = extractReferences(document);

    expect(references.map(({ target, kind }) => ({ target, kind }))).toEqual([
      { target: "database.container", kind: "quadlet" },
      { target: "network-online.target", kind: "unit" },
      { target: "backend.network", kind: "quadlet" },
      { target: "application.pod", kind: "quadlet" },
      { target: "data.volume", kind: "quadlet" },
      { target: "base.image", kind: "quadlet" },
      { target: "archive,base.image", kind: "quadlet" },
      { target: "last.image", kind: "quadlet" },
    ]);
    for (const reference of references) {
      expect(source.slice(reference.span.start, reference.span.end)).toBe(reference.target);
    }
  });

  it("does not confuse OCI resources with references from their own Quadlet files", () => {
    const image = parse(
      "[Image]\nImage=quay.io/example/base.image\n",
      "podman-quadlet",
      "file:///workspace/base.image",
    );
    const artifact = parse(
      "[Artifact]\nArtifact=quay.io/example/data:latest\n",
      "podman-quadlet",
      "file:///workspace/data.artifact",
    );
    const volume = parse(
      "[Volume]\nDriver=image\nImage=base.build\n",
      "podman-quadlet",
      "file:///workspace/data.volume",
    );

    expect(extractReferences(image)).toEqual([]);
    expect(extractReferences(artifact)).toEqual([]);
    expect(extractReferences(volume).map(({ target }) => target)).toEqual(["base.build"]);

    const suffixAmbiguity = parse(
      "[Container]\nImage=quay.io/example/base.image\n",
      "podman-quadlet",
      "file:///workspace/application.container",
    );
    expect(extractReferences(suffixAmbiguity).map(({ target }) => target)).toEqual([
      "quay.io/example/base.image",
    ]);

    const suffixBeforePathHandling = parse(
      "[Container]\nImage=/missing.image\nNetwork=./missing.network\nVolume=/srv/cache.volume:/cache\n",
      "podman-quadlet",
      "file:///workspace/application.container",
    );
    expect(extractReferences(suffixBeforePathHandling).map(({ target }) => target)).toEqual([
      "/missing.image",
      "./missing.network",
    ]);
  });

  it("reports only unresolved mandatory Quadlet references", () => {
    const container = parse(
      "[Container]\nImage=base.image\nNetwork=missing.network\n",
      "podman-quadlet",
      "file:///workspace/application.container",
    );
    const image = parse(
      "[Image]\nImage=quay.io/example/base:latest\n",
      "podman-quadlet",
      "file:///workspace/base.image",
    );

    const diagnostics = analyzeWorkspaceReferences(container, [container, image]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      code: "missing-quadlet-reference",
      severity: "error",
    });
    expect(diagnostics[0]?.message).toContain("missing.network");
  });
});

describe("Quadlet configuration resolution", () => {
  const quadlet = (uri: string, source: string): ParsedDocument =>
    parse(source, "podman-quadlet", uri);

  it("selects one main file and applies type-wide, dash-prefix, and exact drop-ins", () => {
    const vendor = quadlet(
      "file:///usr/share/containers/systemd/web-api.container",
      "[Container]\nImage=vendor.example/web:latest\n",
    );
    const administrator = quadlet(
      "file:///etc/containers/systemd/web-api.container",
      "[Container]\nImage=admin.example/web:latest\n",
    );
    const typeWide = quadlet(
      "file:///etc/containers/systemd/container.d/10-common.conf",
      "[Container]\nEnvironment=TYPE_WIDE=1\n",
    );
    const dashPrefix = quadlet(
      "file:///etc/containers/systemd/web-.container.d/20-prefix.conf",
      "[Container]\nEnvironment=PREFIX=1\n",
    );
    const exact = quadlet(
      "file:///etc/containers/systemd/web-api.container.d/30-exact.conf",
      "[Container]\nEnvironment=EXACT=1\n",
    );

    const resolution = resolveConfigurationDocuments(administrator.uri, [
      vendor,
      exact,
      typeWide,
      administrator,
      dashPrefix,
    ]);

    expect(resolution.baseUri).toBe(administrator.uri);
    expect(resolution.documents.map(({ uri }) => uri)).toEqual([
      administrator.uri,
      typeWide.uri,
      dashPrefix.uri,
      exact.uri,
    ]);
  });

  it("lets a more-specific Quadlet drop-in directory win before source-directory priority", () => {
    const base = quadlet(
      "file:///etc/containers/systemd/web-api.container",
      "[Container]\nImage=example.test/web:latest\n",
    );
    const runtimeBroad = quadlet(
      "file:///run/containers/systemd/container.d/50-policy.conf",
      "[Container]\nEnvironment=SOURCE=runtime-broad\n",
    );
    const administratorSpecific = quadlet(
      "file:///etc/containers/systemd/web-api.container.d/50-policy.conf",
      "[Container]\nEnvironment=SOURCE=admin-specific\n",
    );

    const resolution = resolveConfigurationDocuments(base.uri, [
      runtimeBroad,
      base,
      administratorSpecific,
    ]);
    expect(resolution.dropInUris).toEqual([administratorSpecific.uri]);
  });

  it("resolves template-instance Quadlet drop-ins", () => {
    const template = quadlet(
      "file:///etc/containers/systemd/worker@.container",
      "[Container]\nImage=example.test/worker:latest\n",
    );
    const templateDropIn = quadlet(
      "file:///etc/containers/systemd/worker@.container.d/10-template.conf",
      "[Container]\nEnvironment=TEMPLATE=1\n",
    );
    const instanceDropIn = quadlet(
      "file:///etc/containers/systemd/worker@blue.container.d/20-instance.conf",
      "[Container]\nEnvironment=INSTANCE=blue\n",
    );

    expect(
      resolveConfigurationDocuments("file:///workspace/worker@blue.container", [
        instanceDropIn,
        template,
        templateDropIn,
      ]).documents.map(({ uri }) => uri),
    ).toEqual([template.uri, templateDropIn.uri, instanceDropIn.uri]);
  });
});

describe("mkosi configuration references", () => {
  const mkosi = (uri: string, source = "[Config]\nMinimumVersion=26\n"): ParsedDocument =>
    parse(source, "mkosi", uri);

  it("classifies comma-separated includes, profiles, subimages, and UKI profiles", () => {
    const source = [
      "[Include]",
      "Include=config/common.conf, mkosi-tools",
      "[Config]",
      "Profiles=development,release",
      "Dependencies=base tools",
      "[Content]",
      "UnifiedKernelImageProfiles=mkosi.uki-profiles/secure.conf",
      "",
    ].join("\n");
    const main = mkosi("file:///workspace/mkosi.conf", source);
    const common = mkosi("file:///workspace/config/common.conf");
    const development = mkosi("file:///workspace/mkosi.profiles/development.conf");
    const release = mkosi("file:///workspace/mkosi.profiles/release/mkosi.conf");
    const base = mkosi("file:///workspace/mkosi.images/base.conf");
    const tools = mkosi("file:///workspace/mkosi.images/tools/mkosi.conf");
    const secure = mkosi(
      "file:///workspace/mkosi.uki-profiles/secure.conf",
      "[UKIProfile]\nProfile=ID=secure\n",
    );
    const documents = [main, common, development, release, base, tools, secure];
    const references = extractReferences(main);

    expect(references.map(({ kind, target }) => ({ kind, target }))).toEqual([
      { kind: "mkosi-include", target: "config/common.conf" },
      { kind: "mkosi-include", target: "mkosi-tools" },
      { kind: "mkosi-profile", target: "development" },
      { kind: "mkosi-profile", target: "release" },
      { kind: "mkosi-image", target: "base" },
      { kind: "mkosi-image", target: "tools" },
      { kind: "mkosi-uki-profile", target: "mkosi.uki-profiles/secure.conf" },
    ]);
    for (const reference of references) {
      expect(source.slice(reference.span.start, reference.span.end)).toBe(reference.target);
    }
    expect(
      references.map((reference) =>
        resolveMkosiReferenceDocuments(main, reference, documents).map(({ uri }) => uri),
      ),
    ).toEqual([
      [common.uri],
      [],
      [development.uri],
      [release.uri],
      [base.uri],
      [tools.uri],
      [secure.uri],
    ]);
    expect(analyzeWorkspaceReferences(main, documents)).toEqual([]);
    expect(relativeMkosiPath(main.uri, secure.uri)).toBe("mkosi.uki-profiles/secure.conf");
    expect(mkosiIncludePath(main.uri, "config/../config/common.conf")).toBe(
      "/workspace/config/common.conf",
    );
    expect(mkosiIncludePath(main.uri, "mkosi-tools")).toBeUndefined();
    expect(mkosiIncludePath(main.uri, "config/%D.conf")).toBeUndefined();

    const nested = {
      ...mkosi("file:///workspace/config/common.conf", "[Include]\nInclude=nested.conf\n"),
      mkosiWorkingDirectory: "/workspace",
    };
    const nestedTarget = mkosi("file:///workspace/nested.conf");
    const nestedReference = extractReferences(nested)[0];
    expect(nestedReference).toBeDefined();
    expect(
      nestedReference === undefined
        ? []
        : resolveMkosiReferenceDocuments(nested, nestedReference, [nested, nestedTarget]),
    ).toEqual([nestedTarget]);
  });

  it("resolves profiles within a subimage but dependencies from the project image directory", () => {
    const application = mkosi(
      "file:///workspace/mkosi.images/application/mkosi.conf",
      "[Config]\nProfiles=debug\nDependencies=base\n",
    );
    const rootProfile = mkosi("file:///workspace/mkosi.profiles/debug.conf");
    const imageProfile = mkosi(
      "file:///workspace/mkosi.images/application/mkosi.profiles/debug.conf",
    );
    const base = mkosi("file:///workspace/mkosi.images/base.conf");
    const references = extractReferences(application);

    expect(
      references.map((reference) =>
        resolveMkosiReferenceDocuments(application, reference, [
          application,
          rootProfile,
          imageProfile,
          base,
        ]).map(({ uri }) => uri),
      ),
    ).toEqual([[imageProfile.uri], [base.uri]]);
  });

  it("diagnoses missing dependencies while keeping optional or incompletely indexed paths conservative", () => {
    const document = mkosi(
      "file:///workspace/mkosi.conf",
      "[Include]\nInclude=config/missing.conf\n[Config]\nProfiles=missing\nDependencies=missing\n[Content]\nUnifiedKernelImageProfiles=missing.conf\n",
    );
    expect(analyzeWorkspaceReferences(document, [document])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "missing-mkosi-include", severity: "warning" }),
        expect.objectContaining({ code: "missing-mkosi-profile", severity: "warning" }),
        expect.objectContaining({ code: "missing-mkosi-image", severity: "error" }),
        expect.objectContaining({ code: "missing-mkosi-uki-profile", severity: "warning" }),
      ]),
    );
  });

  it("merges includes at their assignment position, sorted drop-ins, profiles, and local overrides", () => {
    const main = mkosi(
      "file:///workspace/mkosi.conf",
      "[Distribution]\nDistribution=fedora\nRelease=main-before\n[Content]\nPackages=base\n[Include]\nInclude=config/include.conf\n[Distribution]\nRelease=main-after\n[Config]\nProfiles=debug\n",
    );
    const include = mkosi(
      "file:///workspace/config/include.conf",
      "[Distribution]\nRelease=include\n[Content]\nPackages=included\n",
    );
    const firstDropIn = mkosi(
      "file:///workspace/mkosi.conf.d/10-packages.conf",
      "[Content]\nPackages=\nPackages=drop-10\n",
    );
    const secondDropIn = mkosi(
      "file:///workspace/mkosi.conf.d/20-packages.conf",
      "[Content]\nPackages=drop-20\n",
    );
    const profile = mkosi(
      "file:///workspace/mkosi.profiles/debug.conf",
      "[Content]\nPackages=profile\n",
    );
    const localFile = mkosi(
      "file:///workspace/mkosi.local.conf",
      "[Distribution]\nDistribution=arch\n[Content]\nPackages=local-file\n",
    );
    const localDirectory = mkosi(
      "file:///workspace/mkosi.local/mkosi.conf",
      "[Distribution]\nDistribution=debian\n[Content]\nPackages=local-directory\n",
    );

    const resolution = resolveMkosiConfiguration(main.uri, [
      localDirectory,
      profile,
      secondDropIn,
      include,
      main,
      localFile,
      firstDropIn,
    ]);
    expect(resolution.identity).toBe("main");
    expect(resolution.baseUri).toBe(main.uri);
    expect(
      resolution.configuration.entries
        .filter(({ name }) => name === "Distribution")
        .map(({ value }) => value),
    ).toEqual(["debian"]);
    expect(
      resolution.configuration.entries
        .filter(({ name }) => name === "Release")
        .map(({ value }) => value),
    ).toEqual(["main-after"]);
    expect(
      resolution.configuration.entries
        .filter(({ name }) => name === "Packages")
        .map(({ value }) => value),
    ).toEqual(["drop-10", "drop-20", "profile", "local-file", "local-directory"]);
    expect(resolution.configuration.sources).toEqual([
      main.uri,
      include.uri,
      main.uri,
      firstDropIn.uri,
      secondDropIn.uri,
      profile.uri,
      localFile.uri,
      localDirectory.uri,
    ]);
  });

  it("keeps the greatest numeric MinimumVersion across the graph", () => {
    const main = mkosi(
      "file:///workspace/mkosi.conf",
      "[Config]\nMinimumVersion=24.1\n[Include]\nInclude=older.conf\n",
    );
    const older = mkosi(
      "file:///workspace/older.conf",
      "[Config]\nMinimumVersion=23\nMinimumVersion=25\nMinimumVersion=24.9\n",
    );
    expect(
      resolveMkosiConfiguration(main.uri, [main, older])
        .configuration.entries.filter(({ name }) => name === "MinimumVersion")
        .map(({ value }) => value),
    ).toEqual(["25"]);
  });

  it("evaluates settled mkosi match logic and labels host-dependent branches", () => {
    const main = mkosi(
      "file:///workspace/mkosi.conf",
      "[Distribution]\nDistribution=fedora\nRelease=stable\n[Output]\nFormat=disk\n[Include]\nInclude=config/conditional\n",
    );
    const skipped = mkosi(
      "file:///workspace/mkosi.conf.d/10-skipped.conf",
      "[Match]\nDistribution=ubuntu\n[Content]\nPackages=skipped\n",
    );
    const selected = mkosi(
      "file:///workspace/mkosi.conf.d/20-selected.conf",
      "[Match]\nDistribution=|debian\nDistribution=|fedora\n[Content]\nPackages=selected\n",
    );
    const triggered = mkosi(
      "file:///workspace/mkosi.conf.d/30-triggered.conf",
      "[TriggerMatch]\nDistribution=ubuntu\n[TriggerMatch]\nDistribution=fedora\n[Content]\nPackages=triggered\n",
    );
    const conditional = mkosi(
      "file:///workspace/mkosi.conf.d/40-conditional.conf",
      "[Match]\nPathExists=/host-dependent\n[Distribution]\nRelease=conditional\n",
    );
    const outputSelected = mkosi(
      "file:///workspace/mkosi.conf.d/35-output.conf",
      "[Match]\nFormat=disk\n[Content]\nPackages=output-selected\n",
    );
    const skippedDirectory = mkosi(
      "file:///workspace/config/conditional/mkosi.conf",
      "[Match]\nDistribution=ubuntu\n[Content]\nPackages=directory-main\n",
    );
    const skippedDirectoryDropIn = mkosi(
      "file:///workspace/config/conditional/mkosi.conf.d/10-extra.conf",
      "[Content]\nPackages=directory-drop-in\n",
    );

    const resolution = resolveMkosiConfiguration(main.uri, [
      main,
      skipped,
      selected,
      triggered,
      outputSelected,
      conditional,
      skippedDirectory,
      skippedDirectoryDropIn,
    ]);
    expect(
      resolution.configuration.entries
        .filter(({ name }) => name === "Packages")
        .map(({ value }) => value),
    ).toEqual(["selected", "triggered", "output-selected"]);
    expect(
      resolution.configuration.entries
        .filter(({ name, conditional: uncertain }) => name === "Release" && uncertain !== true)
        .map(({ value }) => value),
    ).toEqual(["stable"]);
    expect(
      resolution.configuration.entries.find(
        ({ name, conditional: uncertain }) => name === "Release" && uncertain === true,
      ),
    ).toMatchObject({ value: "conditional", sourceUri: conditional.uri });
    expect(resolution.configuration.sources).not.toContain(skipped.uri);
    expect(resolution.configuration.sources).not.toContain(skippedDirectory.uri);
    expect(renderEffectiveConfiguration(resolution.configuration)).toContain(
      "# Conditional: host-dependent or not-yet-resolved mkosi match",
    );
  });

  it("applies inherited settings below a subimage and universal settings above it", () => {
    const main = mkosi(
      "file:///workspace/mkosi.conf",
      "[Distribution]\nDistribution=fedora\n[Output]\nImageId=main-id\n[Config]\nProfiles=debug\n",
    );
    const mainProfile = mkosi(
      "file:///workspace/mkosi.profiles/debug.conf",
      "[Output]\nImageId=main-profile\n",
    );
    const image = mkosi(
      "file:///workspace/mkosi.images/application/mkosi.conf",
      "[Distribution]\nDistribution=arch\n[Output]\nImageId=image\n",
    );
    const imageProfile = mkosi(
      "file:///workspace/mkosi.images/application/mkosi.profiles/debug.conf",
      "[Output]\nImageId=image-profile\n",
    );
    const imageMatch = mkosi(
      "file:///workspace/mkosi.images/application/mkosi.conf.d/10-match.conf",
      "[Match]\nImage=application\n[Content]\nPackages=matched-subimage\n",
    );

    const resolution = resolveMkosiConfiguration(image.uri, [
      imageMatch,
      imageProfile,
      mainProfile,
      image,
      main,
    ]);
    expect(resolution.identity).toBe("application");
    expect(resolution.baseUri).toBe(image.uri);
    expect(
      resolution.configuration.entries
        .filter(({ name }) => name === "Distribution")
        .map(({ value }) => value),
    ).toEqual(["fedora"]);
    expect(
      resolution.configuration.entries
        .filter(({ name }) => name === "ImageId")
        .map(({ value }) => value),
    ).toEqual(["image-profile"]);
    expect(
      resolution.configuration.entries
        .filter(({ name }) => name === "Packages")
        .map(({ value }) => value),
    ).toEqual(["matched-subimage"]);
  });

  it("resolves tools-tree settings into their target directives with local and multiversal priority", () => {
    const main = mkosi(
      "file:///workspace/mkosi.conf",
      "[Build]\nToolsTreeDistribution=fedora\nToolsTreePackages=main\nWorkspaceDirectory=/main-workspace\n",
    );
    const local = mkosi(
      "file:///workspace/mkosi.local.conf",
      "[Build]\nToolsTreeDistribution=ubuntu\nToolsTreePackages=local\n",
    );
    const tools = mkosi(
      "file:///workspace/mkosi.tools.conf/mkosi.conf",
      "[Distribution]\nDistribution=debian\n[Content]\nPackages=tools\n",
    );

    const resolution = resolveMkosiConfiguration(tools.uri, [tools, local, main]);
    expect(resolution.identity).toBe("tools");
    expect(resolution.baseUri).toBe(tools.uri);
    expect(
      resolution.configuration.entries
        .filter(({ name }) => name === "Distribution")
        .map(({ value }) => value),
    ).toEqual(["ubuntu"]);
    expect(
      resolution.configuration.entries
        .filter(({ name }) => name === "Packages")
        .map(({ value }) => value),
    ).toEqual(["tools", "main", "local"]);
    expect(
      resolution.configuration.entries
        .filter(({ name }) => name === "WorkspaceDirectory")
        .map(({ value }) => value),
    ).toEqual(["/main-workspace"]);
  });

  it("resolves default-initrd inheritance and remaps Initrd settings", () => {
    const main = mkosi(
      "file:///workspace/mkosi.conf",
      "[Distribution]\nDistribution=fedora\n[Content]\nHostname=main\nInitrdPackages=main-initrd\n",
    );
    const initrd = mkosi(
      "file:///workspace/mkosi.initrd.conf/mkosi.conf",
      "[Distribution]\nDistribution=debian\n[Content]\nHostname=initrd\nPackages=initrd-package\n",
    );

    const resolution = resolveMkosiConfiguration(initrd.uri, [initrd, main]);
    expect(resolution.identity).toBe("default-initrd");
    expect(resolution.baseUri).toBe(initrd.uri);
    expect(
      resolution.configuration.entries
        .filter(({ name }) => name === "Distribution")
        .map(({ value }) => value),
    ).toEqual(["fedora"]);
    expect(
      resolution.configuration.entries
        .filter(({ name }) => name === "Hostname")
        .map(({ value }) => value),
    ).toEqual(["initrd"]);
    expect(
      resolution.configuration.entries
        .filter(({ name }) => name === "Packages")
        .map(({ value }) => value),
    ).toEqual(["main-initrd", "initrd-package"]);
  });
});
