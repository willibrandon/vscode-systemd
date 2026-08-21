import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import process from "node:process";

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, "packages/language-core/src/generated/registry.json");
const lockOutput = resolve(root, "data/upstream.lock.json");
const checking = process.argv.includes("--check");
const sources = {
  systemd: resolve(root, process.env.SYSTEMD_SOURCE ?? "../systemd"),
  podman: resolve(root, process.env.PODMAN_SOURCE ?? "../podman"),
  mkosi: resolve(root, process.env.MKOSI_SOURCE ?? "../mkosi"),
};

const unavailable = [];
for (const [name, source] of Object.entries(sources)) {
  try {
    await access(source);
  } catch {
    unavailable.push(name + ":" + source);
  }
}

if (unavailable.length > 0) {
  if (!checking) throw new Error("Missing upstream trees: " + unavailable.join(", "));
  const bundled = JSON.parse(await readFile(output, "utf8"));
  const lock = JSON.parse(await readFile(lockOutput, "utf8"));
  if (!Array.isArray(bundled.directives) || bundled.directives.length < 100) {
    throw new Error("Bundled registry is missing or incomplete.");
  }
  validateLock(lock, bundled.upstream);
  console.log("Validated bundled registry with " + bundled.directives.length + " records.");
  process.exit(0);
}

const records = new Map();
await extractSystemd(sources.systemd);
await extractQuadlet(sources.podman);
await extractMkosi(sources.mkosi);

const directives = [...records.values()].sort((a, b) =>
  [a.dialect, a.section, a.name]
    .join("\0")
    .localeCompare([b.dialect, b.section, b.name].join("\0")),
);
const registry = {
  schemaVersion: 1,
  generatedAt: "1970-01-01T00:00:00.000Z",
  upstream: {
    systemd: revision(sources.systemd),
    podman: revision(sources.podman),
    mkosi: revision(sources.mkosi),
  },
  quadletExtensions: [
    ".artifact",
    ".build",
    ".container",
    ".image",
    ".kube",
    ".network",
    ".pod",
    ".volume",
  ],
  dynamicDirectivePatterns: [
    "^ID_NET_NAME_ALLOW_.+$",
    "^ID_NET_NAME_SLOT_.+$",
    "^ID_NET_NAME_PATH_.+$",
    "^ID_NET_NAME_ONBOARD_.+$",
  ],
  directives,
};
const serialized = JSON.stringify(registry, null, 2) + "\n";
const upstreamLock = {
  schemaVersion: 1,
  adapterVersion: 2,
  sources: {
    systemd: sourceMetadata(
      sources.systemd,
      "https://github.com/systemd/systemd.git",
      "LGPL-2.1-or-later",
    ),
    podman: sourceMetadata(
      sources.podman,
      "https://github.com/podman-container-tools/podman.git",
      "Apache-2.0",
    ),
    mkosi: sourceMetadata(
      sources.mkosi,
      "https://github.com/systemd/mkosi.git",
      "LGPL-2.1-or-later",
    ),
  },
};
validateLock(upstreamLock, registry.upstream);
const serializedLock = JSON.stringify(upstreamLock, null, 2) + "\n";

if (checking) {
  const current = await readFile(output, "utf8");
  if (current !== serialized) {
    throw new Error(
      "Generated registry is stale (" + digest(current) + " != " + digest(serialized) + ").",
    );
  }
  const currentLock = await readFile(lockOutput, "utf8");
  if (currentLock !== serializedLock) {
    throw new Error(
      "Upstream lock is stale (" + digest(currentLock) + " != " + digest(serializedLock) + ").",
    );
  }
  console.log("Generated registry is current with " + directives.length + " records.");
} else {
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, serialized, "utf8");
  await mkdir(dirname(lockOutput), { recursive: true });
  await writeFile(lockOutput, serializedLock, "utf8");
  console.log(
    "Generated " +
      directives.length +
      " records at " +
      output +
      " and refreshed " +
      lockOutput +
      ".",
  );
}

function revision(source) {
  return execFileSync("git", ["-C", source, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
}

function sourceMetadata(source, repository, license) {
  return {
    repository,
    tag: execFileSync("git", ["-C", source, "describe", "--tags", "--abbrev=0"], {
      encoding: "utf8",
    }).trim(),
    revision: revision(source),
    tree: execFileSync("git", ["-C", source, "rev-parse", "HEAD^{tree}"], {
      encoding: "utf8",
    }).trim(),
    license,
  };
}

function validateLock(lock, revisions) {
  if (lock.schemaVersion !== 1 || lock.adapterVersion !== 2 || typeof lock.sources !== "object") {
    throw new Error("Upstream lock has an unsupported schema or adapter version.");
  }
  for (const name of Object.keys(sources)) {
    const source = lock.sources[name];
    if (
      typeof source !== "object" ||
      source === null ||
      !/^https:\/\/github\.com\/.+\.git$/u.test(source.repository) ||
      typeof source.tag !== "string" ||
      source.tag.length === 0 ||
      !/^[0-9a-f]{40}$/u.test(source.revision) ||
      !/^[0-9a-f]{40}$/u.test(source.tree) ||
      typeof source.license !== "string" ||
      source.license.length === 0
    ) {
      throw new Error("Upstream lock entry is incomplete: " + name + ".");
    }
    if (source.revision !== revisions[name]) {
      throw new Error("Upstream lock revision does not match the registry: " + name + ".");
    }
  }
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function add(candidate) {
  if (!/^[A-Za-z][A-Za-z0-9_:@{}.-]*$/u.test(candidate.name)) return;
  const section = candidate.section || "*";
  const key = [candidate.dialect, section, candidate.name].join("\0");
  const value = {
    dialect: candidate.dialect,
    section,
    name: candidate.name,
    valueKind: candidate.valueKind ?? "string",
    since: candidate.since ?? null,
    deprecated: candidate.deprecated ?? false,
    documentation: candidate.documentation,
    summary: candidate.summary ?? candidate.name + " in [" + section + "].",
    choices: candidate.choices ?? [],
  };
  const existing = records.get(key);
  if (existing === undefined || existing.valueKind === "string") records.set(key, value);
}

async function extractSystemd(source) {
  for (const file of (await walk(resolve(source, "src"))).filter((name) =>
    /gperf(?:\.in)?$/u.test(name),
  )) {
    const text = await readFile(file, "utf8");
    const dialect = file.includes("/src/core/")
      ? "systemd-unit"
      : file.includes("/src/network/") || file.includes("/src/udev/net/")
        ? "systemd-network"
        : "systemd-config";
    for (const line of text.split(/\r?\n/u)) {
      const match =
        /^\s*([A-Za-z0-9_@{}:+-]+)\.([A-Za-z][A-Za-z0-9_:@{}+.-]*),\s*(config_parse_[A-Za-z0-9_]+)/u.exec(
          line,
        );
      if (match === null) continue;
      add({
        dialect,
        section: match[1]?.includes("{{") === true ? "*" : match[1],
        name: match[2],
        valueKind: parserKind(match[3] ?? ""),
        documentation:
          "https://www.freedesktop.org/software/systemd/man/latest/systemd.directives.html#" +
          encodeURIComponent(match[2] ?? "") +
          "=",
      });
    }
  }

  for (const file of (await walk(resolve(source, "man"))).filter(
    (name) => extname(name) === ".xml",
  )) {
    const text = await readFile(file, "utf8");
    const manual = basename(file);
    const dialect =
      /^systemd\.(?:unit|service|socket|timer|path|mount|automount|swap|target|device|slice|scope|exec|kill|resource-control)\.xml$/u.test(
        manual,
      )
        ? "systemd-unit"
        : /^systemd\.(?:network|netdev|link|dnssd|dns-delegate)\.xml$/u.test(manual)
          ? "systemd-network"
          : "systemd-config";
    let section = "*";
    const tokens =
      /<title>\s*\[([A-Za-z0-9_:.-]+)\][^<]*<\/title>|<varname>([A-Za-z][A-Za-z0-9_:@{}.-]*)=<\/varname>/gu;
    for (const match of text.matchAll(tokens)) {
      if (match[1] !== undefined) {
        section = match[1];
      } else if (match[2] !== undefined) {
        const tail = text.slice(match.index, match.index + 1400);
        add({
          dialect,
          section,
          name: match[2],
          since: /xpointer="v(\d+)"/u.exec(tail)?.[1] ?? null,
          documentation:
            "https://www.freedesktop.org/software/systemd/man/latest/" +
            basename(file, ".xml") +
            ".html#" +
            encodeURIComponent(match[2]) +
            "=",
        });
      }
    }
  }
}

async function extractQuadlet(source) {
  const text = await readFile(resolve(source, "pkg/systemd/quadlet/quadlet.go"), "utf8");
  const constants = new Map();
  for (const match of text.matchAll(/^\s*([A-Za-z][A-Za-z0-9_]*)\s*=\s*"([^"]*)"/gmu)) {
    constants.set(match[1], match[2]);
  }
  const start = text.indexOf("groupsInfo = map[string]GroupInfo{");
  const lines = text.slice(start).split(/\r?\n/u);
  let section;
  let inKeys = false;
  for (const line of lines) {
    const group = /^\s*([A-Za-z0-9_]+Group):\s*\{/u.exec(line)?.[1];
    if (group !== undefined && !inKeys) {
      section = constants.get(group) ?? group.replace(/Group$/u, "");
      continue;
    }
    if (line.includes("SupportedKeys: map[string]bool{")) {
      inKeys = true;
      continue;
    }
    if (!inKeys || section === undefined) continue;
    const key = /^\s*([A-Za-z0-9_]+):\s*true,/u.exec(line)?.[1];
    if (key !== undefined) {
      const name = constants.get(key);
      if (name !== undefined) {
        add({
          dialect: "podman-quadlet",
          section,
          name,
          valueKind: quadletKind(name),
          documentation: "https://docs.podman.io/en/latest/markdown/podman-systemd.unit.5.html",
        });
      }
    } else if (/^\s*\},?\s*$/u.test(line)) {
      inKeys = false;
    }
  }
}

async function extractMkosi(source) {
  const text = await readFile(resolve(source, "mkosi/config.py"), "utf8");
  const enumChoices = await extractPythonStringEnums(resolve(source, "mkosi"));
  let cursor = 0;
  while ((cursor = text.indexOf("ConfigSetting(", cursor)) >= 0) {
    const block = balancedCall(text, cursor + "ConfigSetting".length);
    cursor = block.end;
    const dest = /\bdest="([^"]+)"/u.exec(block.text)?.[1];
    const section = /\bsection="([^"]+)"/u.exec(block.text)?.[1];
    if (dest === undefined || section === undefined) continue;
    const explicit = /\bname="([^"]+)"/u.exec(block.text)?.[1];
    const name =
      explicit ??
      dest
        .split("_")
        .filter(Boolean)
        .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
        .join("");
    const parser = /\bparse=([A-Za-z0-9_]+)/u.exec(block.text)?.[1] ?? "";
    const help = /\bhelp="([^"]+)"/su.exec(block.text)?.[1];
    const choices = configChoices(block.text, enumChoices);
    add({
      dialect: "mkosi",
      section,
      name,
      valueKind: parserKind(parser),
      documentation: "https://man.archlinux.org/man/mkosi.1.en",
      summary: help === undefined ? undefined : help.replace(/\.$/u, "") + ".",
      choices,
    });
    const aliases = /\bcompat_names=\(([^)]*)\)/su.exec(block.text)?.[1] ?? "";
    for (const alias of aliases.matchAll(/"([^"]+)"/gu)) {
      add({
        dialect: "mkosi",
        section,
        name: alias[1],
        valueKind: parserKind(parser),
        documentation: "https://man.archlinux.org/man/mkosi.1.en",
        deprecated: true,
        summary: "Compatibility alias for " + name + ".",
        choices,
      });
    }
  }
}

async function extractPythonStringEnums(directory) {
  const result = new Map();
  const files = (await walk(directory)).filter((file) => extname(file) === ".py");
  for (const file of files) {
    const lines = (await readFile(file, "utf8")).split(/\r?\n/u);
    for (let index = 0; index < lines.length; index += 1) {
      const declaration = /^class\s+([A-Za-z_][A-Za-z0-9_]*)\([^)]*\bStrEnum\b[^)]*\):\s*$/u.exec(
        lines[index] ?? "",
      );
      if (declaration === null) continue;
      const members = new Map();
      for (index += 1; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        if (line !== "" && !line.startsWith(" ") && !line.startsWith("#")) {
          index -= 1;
          break;
        }
        const assignment = /^ {4}([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*(?:#.*)?$/u.exec(line);
        if (assignment === null) continue;
        const name = assignment[1] ?? "";
        const expression = assignment[2] ?? "";
        const literal = /^(?:"([^"]*)"|'([^']*)')$/u.exec(expression);
        const alias = /^([A-Za-z_][A-Za-z0-9_]*)$/u.exec(expression)?.[1];
        const value =
          expression === "enum.auto()"
            ? name.replaceAll("_", "-")
            : (literal?.[1] ??
              literal?.[2] ??
              (alias === undefined ? undefined : members.get(alias)));
        if (value !== undefined) members.set(name, value);
      }
      result.set(declaration[1] ?? "", [...new Set(members.values())]);
    }
  }
  return result;
}

function configChoices(block, enumChoices) {
  const values = [];
  const literals = /\bchoices\s*=\s*\(([^)]*)\)/su.exec(block)?.[1];
  if (literals !== undefined) {
    for (const match of literals.matchAll(/(?:"([^"]*)"|'([^']*)')/gu)) {
      values.push(match[1] ?? match[2] ?? "");
    }
  }
  const enumCall = /\bchoices\s*=\s*([A-Za-z_][A-Za-z0-9_]*)\.(choices|values)\(\)/u.exec(block);
  if (enumCall !== null) {
    values.push(...(enumChoices.get(enumCall[1] ?? "") ?? []));
    if (enumCall[2] === "choices") values.push("");
  }
  const enumList = /\bchoices\s*=\s*list\(([A-Za-z_][A-Za-z0-9_]*)\)/u.exec(block)?.[1];
  if (enumList !== undefined) values.push(...(enumChoices.get(enumList) ?? []));
  return [...new Set(values)];
}

function balancedCall(text, opening) {
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = opening; index < text.length; index += 1) {
    const character = text[index];
    if (quote !== "") {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
      if (depth === 0) {
        return { text: text.slice(opening + 1, index), end: index + 1 };
      }
    }
  }
  return { text: text.slice(opening + 1), end: text.length };
}

function parserKind(parser) {
  const normalized = parser.toLowerCase();
  if (/(?:^|_)(?:bool|boolean|tristate)(?:_|$)/u.test(normalized)) return "boolean";
  if (/(?:^|_)(?:sec|time|timespan|calendar)(?:_|$)/u.test(normalized)) return "duration";
  if (/(?:^|_)(?:size|bytes)(?:_|$)/u.test(normalized)) return "size";
  if (/(?:^|_)(?:u?int(?:8|16|32|64)?|unsigned|percent|mode|nice)(?:_|$)/u.test(normalized)) {
    return "number";
  }
  if (/(?:^|_)(?:path|filename|directory|image)(?:_|$)/u.test(normalized)) return "path";
  if (/(?:^|_)(?:address|cidr|prefix|gateway|dns)(?:_|$)/u.test(normalized)) return "address";
  if (/(?:^|_)(?:strv|list|set|words)(?:_|$)/u.test(normalized)) return "list";
  if (/(?:^|_)(?:exec|command|argv)(?:_|$)/u.test(normalized)) return "command";
  return "string";
}

function quadletKind(name) {
  if (/^(?:DNS|Gateway|IP|IP6|IPRange|Subnet)$/u.test(name)) return "address";
  if (/(?:Path|File|Rootfs|Yaml|SeccompProfile)$/u.test(name)) return "path";
  if (
    /^(?:Copy|DisableDNS|EnvironmentHost|HttpProxy|IPv6|Internal|KubeDownForce|NoNewPrivileges|Quiet|ReadOnly|ReadOnlyTmpfs|RunInit|TLSVerify)$/u.test(
      name,
    )
  ) {
    return "boolean";
  }
  if (/(?:Timeout|Interval|Period|Delay)$/u.test(name)) return "duration";
  if (/(?:Memory|ShmSize|MaxLogSize)$/u.test(name)) return "size";
  return "string";
}

async function walk(directory) {
  const result = [];
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) result.push(path);
    }
  }
  return result;
}
