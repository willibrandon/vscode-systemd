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
    "basic.artifact",
    "basic.build",
    "basic.container",
    "basic.image",
    "basic.kube",
    "basic.network",
    "basic.pod",
    "basic.volume",
    "comment-with-continuation.container",
    "line-continuation-whitespace.container",
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
    " line records) without diagnostics.",
);

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
