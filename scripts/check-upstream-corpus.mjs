import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { analyze, configureRegistryChannel, parse } from "../packages/language-core/lib/index.js";

const root = resolve(import.meta.dirname, "..");
const sources = {
  systemd: resolve(root, process.env.SYSTEMD_SOURCE ?? "../systemd"),
  podman: resolve(root, process.env.PODMAN_SOURCE ?? "../podman"),
  mkosi: resolve(root, process.env.MKOSI_SOURCE ?? "../mkosi"),
};
configureRegistryChannel("preview");

const corpus = [
  ...[
    "test/units/autorelabel.service",
    "test/test-sched-prio/sched_rr_ok.service",
    "test/integration-tests/TEST-07-PID1/TEST-07-PID1.units/pass-fds-to-exec-no.socket",
    "test/integration-tests/TEST-07-PID1/TEST-07-PID1.units/defer-reactivation.timer",
    "test/test-path/path-changed.path",
    "test/test-fstab-generator/test-12-dev-sdx.expected/sysroot.mount",
    "test/test-fstab-generator/test-18-options.fstab.expected/mnt-automount1.automount",
    "test/test-fstab-generator/test-20-swap-from-cmdline.expected/dev-sdy5.swap",
    "test/test-path/basic.target",
    "test/test-cgroup-mask/nomem.slice",
  ].map((path) => ({ source: "systemd", dialect: "systemd-unit", path })),
  ...[
    "test/test-network-generator-conversion/test-01-dhcp.expected/71-default.network",
    "test/test-network-generator-conversion/test-02-bridge.expected/70-bridge99.netdev",
    "test/fuzz/fuzz-link-parser/99-default.link",
    "test/fuzz/fuzz-netdev-parser/vlan.netdev",
    "test/fuzz/fuzz-netdev-parser/wireguard.netdev",
  ].map((path) => ({ source: "systemd", dialect: "systemd-network", path })),
  ...(await readdir(resolve(sources.systemd, "hwdb.d")))
    .filter((path) => path.endsWith(".hwdb"))
    .sort()
    .map((path) => ({ source: "systemd", dialect: "systemd-hwdb", path: "hwdb.d/" + path })),
  ...[
    "all-tags.image",
    "artifact-mount.container",
    "autoupdate.container",
    "autoupdate.kube",
    "basic.artifact",
    "basic.build",
    "basic.container",
    "basic.image",
    "basic.kube",
    "basic.network",
    "basic.pod",
    "basic.volume",
    "build.quadlet.servicename.volume",
    "build.quadlet.volume",
    "comment-with-continuation.container",
    "dependent.build",
    "dependent.container",
    "dependent.image",
    "dependent.kube",
    "dependent.network",
    "dependent.pod",
    "dependent.volume",
    "exit_code_propagation.kube",
    "image.quadlet.servicename.volume",
    "image.quadlet.volume",
    "line-continuation-whitespace.container",
    "merged.container",
    "network.quadlet.build",
    "network.quadlet.container",
    "network.quadlet.kube",
    "network.quadlet.pod",
    "network.quadlet.servicename.build",
    "network.quadlet.servicename.container",
    "network.quadlet.servicename.kube",
    "network.servicename.quadlet.pod",
    "no_deps.build",
    "no_deps.container",
    "no_deps.image",
    "notify-healthy.container",
    "service-name.build",
    "service-name.container",
    "service-name.image",
    "service-name.kube",
    "service-name.network",
    "service-name.pod",
    "service-name.volume",
    "template@.container",
  ].map((path) => ({
    source: "podman",
    dialect: "podman-quadlet",
    path: "test/e2e/quadlet/" + path,
  })),
  ...[
    "mkosi.conf",
    "mkosi.conf.d/fedora/mkosi.conf",
    "mkosi/resources/mkosi-initrd/mkosi.conf",
    "mkosi/resources/mkosi-vm/mkosi.conf",
    "mkosi/resources/mkosi-tools/mkosi.conf",
  ].map((path) => ({ source: "mkosi", dialect: "mkosi", path })),
];

const failures = [];
let assignments = 0;
let records = 0;
for (const fixture of corpus) {
  const path = resolve(sources[fixture.source], fixture.path);
  let source;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    failures.push(fixture.source + "/" + fixture.path + ": " + errorMessage(error));
    continue;
  }
  const document = parse(source, fixture.dialect, pathToFileURL(path).href);
  assignments += document.nodes.filter((node) => node.kind === "assignment").length;
  records += document.nodes.filter((node) => node.kind === "record").length;
  for (const diagnostic of analyze(document, { maxProblems: 10_000 })) {
    const line = lineAt(document.lineStarts, diagnostic.span.start);
    failures.push(
      fixture.source +
        "/" +
        fixture.path +
        ":" +
        line +
        ": " +
        diagnostic.code +
        ": " +
        diagnostic.message,
    );
  }
}

let quadletReleases = 0;
let quadletReleaseFixtures = 0;
for (const tag of releaseTags(sources.podman)) {
  const paths = new Set(
    execFileSync(
      "git",
      ["-C", sources.podman, "ls-tree", "-r", "--name-only", tag, "--", "test/e2e/quadlet"],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    )
      .split(/\r?\n/u)
      .filter(Boolean),
  );
  const fixtures = [
    ".artifact",
    ".build",
    ".container",
    ".image",
    ".kube",
    ".network",
    ".pod",
    ".volume",
  ]
    .map((extension) => "test/e2e/quadlet/basic" + extension)
    .filter((path) => paths.has(path));
  if (fixtures.length === 0) {
    failures.push("podman/" + tag + ": no basic Quadlet generator fixture found");
    continue;
  }
  quadletReleases += 1;
  for (const path of fixtures) {
    const source = execFileSync("git", ["-C", sources.podman, "show", tag + ":" + path], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    const document = parse(
      source,
      "podman-quadlet",
      "upstream://podman/" + tag + "/" + path.slice(path.lastIndexOf("/") + 1),
    );
    assignments += document.nodes.filter((node) => node.kind === "assignment").length;
    quadletReleaseFixtures += 1;
    for (const diagnostic of analyze(document, {
      maxProblems: 10_000,
      targetVersions: { "podman-quadlet": tag.slice(1) },
    })) {
      failures.push(
        "podman/" +
          tag +
          "/" +
          path +
          ":" +
          lineAt(document.lineStarts, diagnostic.span.start) +
          ": " +
          diagnostic.code +
          ": " +
          diagnostic.message,
      );
    }
  }
}

if (failures.length > 0) {
  throw new Error("Pinned upstream fixture conformance failed:\n- " + failures.join("\n- "));
}

console.log(
  "Parsed " +
    corpus.length +
    " pinned upstream fixtures (" +
    assignments +
    " assignments and " +
    records +
    " line records), plus " +
    quadletReleaseFixtures +
    " Quadlet fixtures across " +
    quadletReleases +
    " Podman releases, without diagnostics.",
);

function releaseTags(source) {
  return execFileSync("git", ["-C", source, "tag", "--list", "--sort=v:refname"], {
    encoding: "utf8",
  })
    .split(/\r?\n/u)
    .filter((tag) => /^v\d+\.\d+\.\d+$/u.test(tag))
    .filter((tag) => {
      const [major = 0, minor = 0] = tag
        .slice(1)
        .split(".")
        .map((part) => Number.parseInt(part, 10));
      return major > 4 || (major === 4 && minor >= 4);
    });
}

function lineAt(lineStarts, offset) {
  let low = 0;
  let high = lineStarts.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((lineStarts[middle] ?? 0) <= offset) low = middle + 1;
    else high = middle;
  }
  return Math.max(1, low);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
