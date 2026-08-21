import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { clearTimeout, setTimeout } from "node:timers";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";

const largeUri = "file:///workspace/performance/large.service";
const indexedDocuments = Array.from({ length: 250 }, (_, index) => ({
  uri: `file:///workspace/performance/dependency-${String(index).padStart(3, "0")}.service`,
  languageId: "systemd-unit",
  source: [
    "[Unit]",
    `Description=Indexed dependency ${index}`,
    `After=dependency-${String((index + 249) % 250).padStart(3, "0")}.service`,
    "[Service]",
    "Type=oneshot",
    `ExecStart=/usr/bin/printf indexed-${index}`,
    "",
  ].join("\n"),
  mtime: index + 1,
  workspaceOwned: true,
}));
const environmentLines = Array.from(
  { length: 6_000 },
  (_, index) => `Environment=PROPERTY_${index}=value-${index}`,
);
const sourceLines = [
  "[Unit]",
  "Description=Large representative service",
  "After=dependency-001.service dependency-002.service",
  "Wants=dependency-003.service",
  "",
  "[Service]",
  "Type=oneshot",
  "ExecStart=/usr/bin/printf ready",
  ...environmentLines,
  "",
];
const source = sourceLines.join("\n");

const server = spawn(process.execPath, ["dist/nodeServer.cjs", "--stdio"], {
  cwd: new URL("../..", import.meta.url),
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});
let serverErrors = "";
server.stderr.on("data", (chunk) => {
  serverErrors += chunk.toString("utf8");
});
const client = createMessageConnection(
  new StreamMessageReader(server.stdout),
  new StreamMessageWriter(server.stdin),
);
client.listen();

try {
  await client.sendRequest("initialize", {
    processId: null,
    rootUri: "file:///workspace",
    capabilities: {},
    clientInfo: { name: "performance gate" },
  });
  await client.sendNotification("initialized", {});
  await client.sendNotification("systemd/index/documents", {
    replace: true,
    documents: indexedDocuments,
  });

  const firstDiagnostics = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Initial diagnostics timed out.")), 5_000);
    const disposable = client.onNotification("textDocument/publishDiagnostics", (params) => {
      if (params.uri !== largeUri) return;
      clearTimeout(timeout);
      disposable.dispose();
      resolve(params);
    });
  });
  await client.sendNotification("textDocument/didOpen", {
    textDocument: {
      uri: largeUri,
      languageId: "systemd-unit",
      version: 1,
      text: source,
    },
  });
  await firstDiagnostics;

  const completionPosition = { line: sourceLines.length - 1, character: 0 };
  for (let index = 0; index < 5; index += 1) await completion(completionPosition);

  const incrementalSamples = [];
  for (let index = 0; index < 20; index += 1) {
    const started = performance.now();
    await client.sendNotification("textDocument/didChange", {
      textDocument: { uri: largeUri, version: index + 2 },
      contentChanges: [
        {
          range: {
            start: { line: 1, character: 12 },
            end: { line: 1, character: 13 },
          },
          text: index % 2 === 0 ? "l" : "L",
        },
      ],
    });
    await completion(completionPosition);
    incrementalSamples.push(performance.now() - started);
  }

  const cachedSamples = [];
  for (let index = 0; index < 30; index += 1) {
    const started = performance.now();
    await completion(completionPosition);
    cachedSamples.push(performance.now() - started);
  }

  const incrementalP95 = percentile(incrementalSamples, 0.95);
  const cachedP95 = percentile(cachedSamples, 0.95);
  assert.ok(
    incrementalP95 < 300,
    `Warm incremental edit plus completion p95 was ${incrementalP95.toFixed(1)} ms (budget: 300 ms).`,
  );
  assert.ok(
    cachedP95 < 100,
    `Warm cached completion p95 was ${cachedP95.toFixed(1)} ms (budget: 100 ms).`,
  );
  process.stdout.write(
    `Interactive performance passed on ${indexedDocuments.length} indexed units and ${environmentLines.length} assignments: ` +
      `incremental+completion p95=${incrementalP95.toFixed(1)} ms, cached completion p95=${cachedP95.toFixed(1)} ms.\n`,
  );
} finally {
  await client.sendNotification("textDocument/didClose", { textDocument: { uri: largeUri } });
  await client.sendRequest("shutdown");
  await client.sendNotification("exit");
  const exitCode = await processExit(server, 2_000);
  client.dispose();
  assert.equal(exitCode, 0, `Language server exited with ${exitCode}: ${serverErrors}`);
}

async function completion(position) {
  const items = await client.sendRequest("textDocument/completion", {
    textDocument: { uri: largeUri },
    position,
  });
  assert.ok(Array.isArray(items) && items.some(({ label }) => label === "Restart"));
}

function percentile(samples, fraction) {
  const ordered = [...samples].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * fraction))] ?? Infinity;
}

function processExit(child, timeoutMilliseconds) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve(child.exitCode);
      return;
    }
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMilliseconds);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
}
