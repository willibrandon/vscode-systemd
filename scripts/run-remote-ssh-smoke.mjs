import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { downloadAndUnzipVSCode, runVSCodeCommand } from "@vscode/test-electron";
import {
  createRemoteCodeLaunch,
  requireLinuxDockerEngine,
  sshConfigPath,
  sshNullDevice,
} from "./remote-smoke-host.mjs";
import { createIsolatedVSCodeEnvironment } from "./vscode-test-environment.mjs";

const executeFile = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const vsix = resolve(root, process.env.VSIX_PATH ?? `dist/systemd-${manifest.version}.vsix`);
const remoteSshVersion = "0.124.0";
const temporaryRoot = await mkdtemp(join(tmpdir(), "vscode-systemd-remote-"));
const artifactDirectory = resolve(root, "dist/remote-smoke");
const container = `vscode-systemd-remote-${process.pid}`;
const image = `${container}:test`;
const extensionIdentifier = `${manifest.publisher}.${manifest.name}`;
const expectedRemoteExtensionPath = `/home/vscode/.vscode-server/extensions/${extensionIdentifier}-${manifest.version}`;
const key = resolve(temporaryRoot, "id_ed25519");
const sshConfig = resolve(temporaryRoot, "ssh-config");
const bootstrapUserDataDirectory = resolve(temporaryRoot, "bootstrap-user-data");
const userDataDirectory = resolve(temporaryRoot, "user-data");
const extensionsDirectory = resolve(temporaryRoot, "extensions");
const probeVsix = resolve(temporaryRoot, "systemd-remote-smoke-probe.vsix");
const resultPath = "/home/vscode/workspace/.remote-smoke-result.json";
const remoteVsix = `/home/vscode/${basename(vsix)}`;
const remoteProbeVsix = "/home/vscode/systemd-remote-smoke-probe.vsix";
let bootstrapProcess;
let smokeProcess;
let containerStarted = false;

try {
  await requireFile(vsix);
  await Promise.all([
    mkdir(resolve(bootstrapUserDataDirectory, "User"), { recursive: true }),
    mkdir(resolve(userDataDirectory, "User"), { recursive: true }),
    mkdir(extensionsDirectory, { recursive: true }),
    rm(artifactDirectory, { recursive: true, force: true }).then(() =>
      mkdir(artifactDirectory, { recursive: true }),
    ),
  ]);
  const { stdout: dockerOperatingSystem } = await run("docker", [
    "info",
    "--format",
    "{{.OSType}}",
  ]);
  requireLinuxDockerEngine(dockerOperatingSystem);
  await run("docker", [
    "build",
    "--file",
    resolve(root, "test/remote/Dockerfile"),
    "--tag",
    image,
    resolve(root, "test/remote"),
  ]);
  await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
  const runningInContainer = existsSync("/.dockerenv");
  const networkArguments = runningInContainer
    ? ["--network", `container:${hostname()}`]
    : ["--publish", "127.0.0.1::22"];
  await run("docker", ["run", "--detach", "--name", container, ...networkArguments, image]);
  containerStarted = true;
  await run("docker", ["cp", `${key}.pub`, `${container}:/tmp/ci-key.pub`]);
  await run("docker", [
    "exec",
    container,
    "install",
    "-m",
    "600",
    "-o",
    "vscode",
    "-g",
    "vscode",
    "/tmp/ci-key.pub",
    "/home/vscode/.ssh/authorized_keys",
  ]);
  const port = runningInContainer
    ? 22
    : parsePort((await run("docker", ["port", container, "22/tcp"])).stdout);
  await writeFile(
    sshConfig,
    [
      "Host systemd-ci",
      "  HostName 127.0.0.1",
      `  Port ${port}`,
      "  User vscode",
      `  IdentityFile ${sshConfigPath(key)}`,
      "  IdentitiesOnly yes",
      "  StrictHostKeyChecking no",
      `  UserKnownHostsFile ${sshNullDevice(process.platform)}`,
      "",
    ].join("\n"),
    "utf8",
  );
  if (process.platform !== "win32") await chmod(sshConfig, 0o600);
  const sshProbe = ["-F", sshConfig, "-o", "BatchMode=yes", "systemd-ci", "true"];
  await waitFor(() => commandSucceeds("ssh", sshProbe), 30_000, "the remote SSH daemon");
  const settings = `${JSON.stringify(
    {
      "extensions.autoCheckUpdates": false,
      "extensions.autoUpdate": false,
      "remote.SSH.configFile": sshConfig,
      "remote.SSH.localServerDownload": "always",
      "remote.SSH.remotePlatform": { "systemd-ci": "linux" },
      "remote.SSH.showLoginTerminal": false,
      "remote.SSH.useExecServer": false,
      "remote.SSH.useLocalServer": false,
      "security.workspace.trust.enabled": false,
      "telemetry.telemetryLevel": "off",
      "update.mode": "none",
    },
    undefined,
    2,
  )}\n`;
  await Promise.all([
    writeFile(resolve(bootstrapUserDataDirectory, "User/settings.json"), settings, "utf8"),
    writeFile(resolve(userDataDirectory, "User/settings.json"), settings, "utf8"),
  ]);

  await prepareRemoteWorkspace(container, remoteVsix);
  await packageProbe(probeVsix);
  await run("docker", ["cp", probeVsix, `${container}:${remoteProbeVsix}`]);

  const version = process.env.VSCODE_VERSION ?? "stable";
  const vscodeExecutable = await downloadAndUnzipVSCode(version);
  const commandEnvironment = createIsolatedVSCodeEnvironment();
  await runCodeCommand(
    [
      "--user-data-dir",
      bootstrapUserDataDirectory,
      "--extensions-dir",
      extensionsDirectory,
      "--install-extension",
      `ms-vscode-remote.remote-ssh@${remoteSshVersion}`,
      "--force",
    ],
    version,
    commandEnvironment,
  );
  const { stdout: versionOutput } = await runCodeCommand(
    ["--version", "--user-data-dir", bootstrapUserDataDirectory],
    version,
    commandEnvironment,
  );
  const [, commit] = versionOutput.trim().split(/\r?\n/u);
  if (!/^[0-9a-f]{40}$/u.test(commit ?? "")) {
    throw new Error(
      `Unable to determine the VS Code commit from ${JSON.stringify(versionOutput)}.`,
    );
  }
  bootstrapProcess = launchRemoteCode(
    vscodeExecutable,
    bootstrapUserDataDirectory,
    extensionsDirectory,
    "/home/vscode/workspace",
    commandEnvironment,
  );
  const codeServer = await waitForValue(
    async () => {
      if (
        bootstrapProcess !== undefined &&
        (bootstrapProcess.exitCode !== null || bootstrapProcess.signalCode !== null)
      ) {
        throw new Error(
          `VS Code exited with ${bootstrapProcess.exitCode ?? bootstrapProcess.signalCode} before the remote server started.`,
        );
      }
      return findRemoteCodeServer(container, commit);
    },
    300_000,
    "VS Code Server bootstrap",
  );
  await stop(bootstrapProcess);
  bootstrapProcess = undefined;

  await run("docker", [
    "exec",
    "--user",
    "vscode",
    container,
    codeServer,
    "--server-data-dir",
    "/home/vscode/.vscode-server",
    "--install-extension",
    remoteVsix,
    "--force",
  ]);
  await run("docker", [
    "exec",
    "--user",
    "vscode",
    container,
    codeServer,
    "--server-data-dir",
    "/home/vscode/.vscode-server",
    "--install-extension",
    remoteProbeVsix,
    "--force",
  ]);
  const { stdout: installed } = await run("docker", [
    "exec",
    "--user",
    "vscode",
    container,
    codeServer,
    "--server-data-dir",
    "/home/vscode/.vscode-server",
    "--list-extensions",
    "--show-versions",
  ]);
  requireInstalledExtension(installed, `${extensionIdentifier}@${manifest.version}`);
  requireInstalledExtension(installed, "willibrandon.systemd-remote-smoke-probe@0.0.0");

  smokeProcess = launchRemoteCode(
    vscodeExecutable,
    userDataDirectory,
    extensionsDirectory,
    "/home/vscode/workspace",
    commandEnvironment,
  );
  await waitFor(
    async () => commandSucceeds("docker", ["exec", container, "test", "-f", resultPath]),
    120_000,
    "remote extension-host assertions",
  );
  await run("docker", [
    "cp",
    `${container}:${resultPath}`,
    resolve(artifactDirectory, "result.json"),
  ]);
  const result = JSON.parse(await readFile(resolve(artifactDirectory, "result.json"), "utf8"));
  validateResult(result);
  await copyLanguageServerLog(container, artifactDirectory);
  await writeFile(
    resolve(artifactDirectory, "environment.json"),
    `${JSON.stringify(
      {
        vscodeVersion: versionOutput.trim().split(/\r?\n/u)[0],
        vscodeCommit: commit,
        remoteSshVersion,
        image:
          "debian:trixie-slim@sha256:3a39a0592364683e6bab97937b72cad5a8fa6dcbbee90edb3bb48c7f8e94f258",
      },
      undefined,
      2,
    )}\n`,
    "utf8",
  );
  console.log(
    `Verified ${extensionIdentifier}@${manifest.version} in an ephemeral Remote SSH extension host.`,
  );
} catch (error) {
  await collectFailureEvidence(error);
  throw error;
} finally {
  await Promise.allSettled([
    bootstrapProcess === undefined ? Promise.resolve() : stop(bootstrapProcess),
    smokeProcess === undefined ? Promise.resolve() : stop(smokeProcess),
  ]);
  if (containerStarted) {
    await executeFile("docker", ["rm", "--force", container], {
      cwd: root,
      maxBuffer: 1024 * 1024,
      timeout: 30_000,
    }).catch(() => undefined);
  }
  await executeFile("docker", ["image", "rm", "--force", image], {
    cwd: root,
    maxBuffer: 1024 * 1024,
    timeout: 30_000,
  }).catch(() => undefined);
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function prepareRemoteWorkspace(containerName, extensionVsix) {
  const staging = resolve(temporaryRoot, "workspace");
  await cp(resolve(root, "test/integration/fixtures"), staging, { recursive: true });
  await run("docker", ["exec", containerName, "mkdir", "-p", "/home/vscode/workspace"]);
  await run("docker", ["cp", `${staging}/.`, `${containerName}:/home/vscode/workspace`]);
  await run("docker", [
    "exec",
    containerName,
    "chown",
    "-R",
    "vscode:vscode",
    "/home/vscode/workspace",
  ]);
  await run("docker", ["cp", vsix, `${containerName}:${extensionVsix}`]);
  await run("docker", ["exec", containerName, "chown", "vscode:vscode", extensionVsix]);
}

async function packageProbe(output) {
  const vsce = resolve(root, "node_modules/@vscode/vsce/vsce");
  await run(process.execPath, [vsce, "package", "--no-dependencies", "--out", output], {
    cwd: resolve(root, "test/remote/probe"),
  });
}

function launchRemoteCode(executable, userData, extensions, remotePath, environment) {
  const launch = createRemoteCodeLaunch(process.platform, executable, [
    "--no-cached-data",
    "--disable-workspace-trust",
    "--user-data-dir",
    userData,
    "--extensions-dir",
    extensions,
    "--new-window",
    "--remote",
    "ssh-remote+systemd-ci",
    remotePath,
    "--disable-updates",
    "--skip-welcome",
    "--skip-release-notes",
  ]);
  return spawn(launch.command, launch.arguments, {
    cwd: root,
    detached: true,
    env: environment,
    shell: false,
    stdio: "inherit",
    windowsHide: true,
  });
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32" && child.pid !== undefined) {
    await executeFile("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      cwd: root,
      maxBuffer: 1024 * 1024,
      timeout: 10_000,
    }).catch(() => child.kill());
    await Promise.race([once(child, "exit"), delay(5_000)]);
    return;
  }
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      return;
    }
  }
  await Promise.race([once(child, "exit"), delay(5_000)]);
  if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // The process exited after the status check.
    }
  }
}

async function copyLanguageServerLog(containerName, destination) {
  const { stdout } = await run("docker", [
    "exec",
    containerName,
    "find",
    "/home/vscode/.vscode-server/data/logs",
    "-type",
    "f",
    "-path",
    "*willibrandon.systemd/systemd Language Server.log",
  ]);
  const logs = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();
  const log = logs.at(-1);
  if (log === undefined) throw new Error("The remote systemd output log was not created.");
  await run("docker", [
    "cp",
    `${containerName}:${log}`,
    resolve(destination, "language-server.log"),
  ]);
}

async function collectFailureEvidence(error) {
  const evidence = {
    error: error instanceof Error ? error.stack : String(error),
    containerLogs: containerStarted ? await capture("docker", ["logs", container]) : undefined,
    remoteServerTree: containerStarted
      ? await capture("docker", [
          "exec",
          container,
          "find",
          "/home/vscode/.vscode-server",
          "-maxdepth",
          "8",
          "-printf",
          "%M %s %p\\n",
        ])
      : undefined,
    localLogs: {
      bootstrap: await collectLocalLogs(bootstrapUserDataDirectory),
      smoke: await collectLocalLogs(userDataDirectory),
    },
    localLogFiles: await listFiles(userDataDirectory),
  };
  await writeFile(
    resolve(artifactDirectory, "failure.json"),
    `${JSON.stringify(evidence, undefined, 2)}\n`,
    "utf8",
  ).catch(() => undefined);
  process.stderr.write(`${evidence.remoteServerTree ?? ""}\n`);
}

async function collectLocalLogs(profileDirectory) {
  const logsDirectory = resolve(profileDirectory, "logs");
  const logs = {};
  for (const path of await listFiles(logsDirectory)) {
    logs[path.slice(temporaryRoot.length + 1)] = await readFile(path, "utf8").catch(String);
  }
  return logs;
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = resolve(directory, entry.name);
      return entry.isDirectory() ? listFiles(path) : Promise.resolve([path]);
    }),
  );
  return nested.flat();
}

async function findRemoteCodeServer(containerName, commit) {
  const directory = `/home/vscode/.vscode-server/bin/${commit}`;
  const executable = `${directory}/bin/code-server`;
  const complete = await commandSucceeds("docker", [
    "exec",
    containerName,
    "test",
    "-x",
    `${directory}/node`,
    "-a",
    "-x",
    executable,
  ]);
  return complete ? executable : undefined;
}

function validateResult(result) {
  if (typeof result !== "object" || result === null || result.ok !== true) {
    throw new Error(`Remote smoke assertions failed: ${JSON.stringify(result)}.`);
  }
  if (
    result.remoteName !== "ssh-remote" ||
    result.workspaceScheme !== "file" ||
    typeof result.extensionPath !== "string" ||
    result.extensionPath !== expectedRemoteExtensionPath ||
    result.extensionVersion !== manifest.version ||
    typeof result.extensionHostExecutable !== "string" ||
    !result.extensionHostExecutable.startsWith("/home/vscode/.vscode-server/") ||
    typeof result.languageServerProcess !== "string" ||
    !result.languageServerProcess.includes(`${expectedRemoteExtensionPath}/dist/nodeServer.cjs`) ||
    !Array.isArray(result.diagnosticCodes) ||
    !result.diagnosticCodes.includes("unknown-setting") ||
    !Array.isArray(result.completionLabels) ||
    !result.completionLabels.includes("Restart") ||
    result.definitionUri !== "file:///home/vscode/workspace/other.service"
  ) {
    throw new Error(`Remote smoke evidence is incomplete: ${JSON.stringify(result)}.`);
  }
}

function requireInstalledExtension(output, expected) {
  const installed = output
    .split(/\r?\n/u)
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean);
  if (!installed.includes(expected.toLowerCase())) {
    throw new Error(`Remote profile contains ${JSON.stringify(installed)}, expected ${expected}.`);
  }
}

function parsePort(output) {
  const match = /:(\d+)\s*$/u.exec(output.trim());
  const port = Number.parseInt(match?.[1] ?? "", 10);
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`Unable to parse the published SSH port from ${JSON.stringify(output)}.`);
  }
  return port;
}

async function waitFor(predicate, timeoutMilliseconds, description) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function waitForValue(probe, timeoutMilliseconds, description) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function commandSucceeds(command, arguments_) {
  try {
    await executeFile(command, arguments_, {
      cwd: root,
      maxBuffer: 1024 * 1024,
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}

async function capture(command, arguments_) {
  try {
    const result = await executeFile(command, arguments_, {
      cwd: root,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 30_000,
    });
    return `${result.stdout}${result.stderr}`;
  } catch (error) {
    if (typeof error === "object" && error !== null) {
      const stdout = "stdout" in error ? String(error.stdout) : "";
      const stderr = "stderr" in error ? String(error.stderr) : "";
      return `${stdout}${stderr}`;
    }
    return String(error);
  }
}

async function run(command, arguments_, options = {}) {
  const result = await executeFile(command, arguments_, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    maxBuffer: 8 * 1024 * 1024,
    timeout: 300_000,
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  return result;
}

async function runCodeCommand(arguments_, version, environment) {
  const result = await runVSCodeCommand(arguments_, {
    spawn: { env: environment },
    version,
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  return result;
}

async function requireFile(path) {
  await readFile(path);
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => globalThis.setTimeout(resolvePromise, milliseconds));
}
