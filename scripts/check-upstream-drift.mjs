import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { parse } from "yaml";

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const sourceArgument = valueAfter("--source");
const upstream = resolve(
  sourceArgument ?? process.env.SYSTEMD_SOURCE ?? resolve(root, "../systemd"),
);
const reportOnly = process.argv.includes("--report-only");
const baseline = JSON.parse(await readFile(resolve(root, "data/upstream-baseline.json"), "utf8"));
const registry = parse(await readFile(resolve(root, "data/directives.yaml"), "utf8"), {
  merge: true,
});
const current = await snapshot(upstream);
const reviewedDirectives = registry.directives.map(({ name }) => name).sort();
const report = {
  baselineRevision: baseline.revision,
  currentRevision: current.revision,
  revisionMatches: baseline.revision === current.revision,
  directives: {
    addedToUpstream: current.directives.filter((name) => !reviewedDirectives.includes(name)),
    removedFromUpstream: reviewedDirectives.filter((name) => !current.directives.includes(name)),
    parserSourceChanged: current.configSha256 !== baseline.configSha256,
  },
  manualDateSectionsChanged: current.manualDateSectionsSha256 !== baseline.manualDateSectionsSha256,
  shellTests: compareFiles(baseline.shellTests, current.shellTests),
  configTemplates: compareFiles(baseline.configTemplates, current.configTemplates),
};
const drift =
  !report.revisionMatches ||
  report.directives.addedToUpstream.length > 0 ||
  report.directives.removedFromUpstream.length > 0 ||
  report.directives.parserSourceChanged ||
  report.manualDateSectionsChanged ||
  hasFileChanges(report.shellTests) ||
  hasFileChanges(report.configTemplates);
const output = resolve(root, valueAfter("--output") ?? "dist/upstream-drift.json");
await mkdir(resolve(output, ".."), { recursive: true });
await writeFile(output, `${JSON.stringify({ drift, ...report }, null, 2)}\n`, "utf8");

console.log(
  `${drift ? "Upstream drift detected" : "Pinned upstream snapshot verified"}: ${current.revision} (${current.directives.length} directives, ${Object.keys(current.shellTests).length} shell tests, ${Object.keys(current.configTemplates).length} config templates).`,
);
if (drift && !reportOnly) {
  throw new Error(`Upstream input differs from reviewed baseline; inspect ${output}.`);
}

async function snapshot(directory) {
  const config = await readFile(resolve(directory, "config.c"), "utf8");
  const manual = await readFile(resolve(directory, "systemd.8.in"), "utf8");
  const { stdout } = await execute("git", ["rev-parse", "HEAD"], { cwd: directory });
  return {
    revision: stdout.trim(),
    directives: [
      ...new Set(
        [...config.matchAll(/(?:!?strcmp)\(key,\s*"([a-z][a-z0-9]*)"\)/gu)].map(
          (match) => match[1],
        ),
      ),
    ].sort(),
    configSha256: sha256(config),
    manualDateSectionsSha256: sha256(dateContext(manual)),
    shellTests: await fileHashes(resolve(directory, "test"), /^test-[0-9]{4}\.sh$/u),
    configTemplates: await fileHashes(resolve(directory, "test"), /^test-config\.[0-9]+\.in$/u),
  };
}

async function fileHashes(directory, pattern) {
  const names = (await readdir(directory)).filter((name) => pattern.test(name)).sort();
  return Object.fromEntries(
    await Promise.all(
      names.map(async (name) => [name, sha256(await readFile(resolve(directory, name)))]),
    ),
  );
}

function dateContext(manual) {
  const lines = manual.split(/\r\n|\n|\r/u);
  const selected = new Set();
  for (const [index, line] of lines.entries()) {
    if (!/dateformat|dateyesterday|datehourago/iu.test(line)) continue;
    for (
      let cursor = Math.max(0, index - 8);
      cursor <= Math.min(lines.length - 1, index + 16);
      cursor += 1
    ) {
      selected.add(cursor);
    }
  }
  return [...selected]
    .sort((left, right) => left - right)
    .map((index) => lines[index])
    .join("\n");
}

function compareFiles(expected, actual) {
  return {
    added: Object.keys(actual).filter((name) => expected[name] === undefined),
    removed: Object.keys(expected).filter((name) => actual[name] === undefined),
    changed: Object.keys(actual).filter(
      (name) => expected[name] !== undefined && expected[name] !== actual[name],
    ),
  };
}

function hasFileChanges(change) {
  return change.added.length > 0 || change.removed.length > 0 || change.changed.length > 0;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}
