import { spawn } from "node:child_process";
import type { SpawnOptionsWithoutStdio } from "node:child_process";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";

const maximumStagedFiles = 256;
const maximumStagedFileBytes = 2 * 1024 * 1024;
const maximumStagedBytes = 16 * 1024 * 1024;
const oldestAuditedMkosiMajor = 16;
const newestAuditedMkosiMajor = 26;

export type ValidationKind = "systemd-unit" | "quadlet" | "mkosi";

export interface ValidationStaging {
  readonly kind: ValidationKind;
  readonly sourcePath: string;
  readonly sourceRoot: string;
}

export interface ProcessResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly truncated: boolean;
  readonly cancelled: boolean;
}

export interface ValidationInvocation {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly label: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly staging?: ValidationStaging;
  readonly capabilityPolicy?: ValidationKind;
}

export interface ValidationResult extends ProcessResult {
  readonly label: string;
}

export function validationInvocation(
  languageId: string,
  configurationPath: string,
  executables: Readonly<{
    systemdAnalyze: string;
    quadletGenerator: string;
    mkosi: string;
  }>,
): ValidationInvocation | undefined {
  if (languageId === "systemd-unit") {
    const sourceRoot = configurationRoot("systemd-unit", configurationPath);
    return {
      executable: executables.systemdAnalyze,
      arguments: ["verify", configurationPath],
      cwd: sourceRoot,
      label: "systemd-analyze verify",
      staging: { kind: "systemd-unit", sourcePath: configurationPath, sourceRoot },
      capabilityPolicy: "systemd-unit",
    };
  }
  if (languageId === "podman-quadlet") {
    const sourceRoot = configurationRoot("quadlet", configurationPath);
    return {
      executable: executables.quadletGenerator,
      arguments: ["-dryrun"],
      cwd: sourceRoot,
      label: "Quadlet generator dry run",
      environment: { QUADLET_UNIT_DIRS: sourceRoot },
      staging: { kind: "quadlet", sourcePath: configurationPath, sourceRoot },
      capabilityPolicy: "quadlet",
    };
  }
  if (languageId === "mkosi") {
    const sourceRoot = configurationRoot("mkosi", configurationPath);
    return {
      executable: executables.mkosi,
      arguments: ["--no-pager", "--directory", sourceRoot, "summary"],
      cwd: sourceRoot,
      label: "mkosi summary",
      staging: { kind: "mkosi", sourcePath: configurationPath, sourceRoot },
      capabilityPolicy: "mkosi",
    };
  }
  return undefined;
}

export async function runValidator(
  invocation: ValidationInvocation,
  signal: AbortSignal,
  isTrusted: () => boolean,
): Promise<ValidationResult> {
  if (!isTrusted()) throw new Error("Trust this workspace before running an installed tool.");
  if (signal.aborted) return { label: invocation.label, ...emptyResult(true) };
  const temporaryRoot = await mkdtemp(join(tmpdir(), "vscode-systemd-validator-"));
  try {
    await Promise.all([
      mkdir(join(temporaryRoot, "home")),
      mkdir(join(temporaryRoot, "tmp")),
      mkdir(join(temporaryRoot, "xdg-cache")),
      mkdir(join(temporaryRoot, "xdg-config")),
      mkdir(join(temporaryRoot, "xdg-data")),
    ]);
    const prepared = await prepareInvocation(invocation, temporaryRoot, signal);
    if (!isTrusted()) throw new Error("Workspace trust was revoked during installed validation.");
    const capable = await applyCapabilityPolicy(prepared.invocation, signal, temporaryRoot);
    if (!isTrusted()) throw new Error("Workspace trust was revoked during installed validation.");
    const result = await runProcess(capable, signal, temporaryRoot);
    if (!isTrusted()) throw new Error("Workspace trust was revoked during installed validation.");
    return {
      label: invocation.label,
      ...remapResult(result, prepared.pathMappings, temporaryRoot),
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function runProcess(
  invocation: ValidationInvocation,
  signal: AbortSignal,
  privateRoot: string,
): Promise<ProcessResult> {
  return new Promise((resolve, reject): void => {
    if (signal.aborted) {
      resolve(emptyResult(true));
      return;
    }
    const options: SpawnOptionsWithoutStdio = {
      cwd: invocation.cwd,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: "pipe",
      env: validatorEnvironment(privateRoot, invocation.environment),
    };
    const child = spawn(invocation.executable, [...invocation.arguments], options);
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let timedOut = false;
    let truncated = false;
    let cancelled = false;
    let settled = false;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (): void => {
      forceTimer ??= terminate(child.pid, child.kill.bind(child));
    };
    const collect = (current: string, chunk: Buffer): string => {
      const maximum = 256 * 1024;
      const remaining = Math.max(0, maximum - outputBytes);
      const selected = chunk.subarray(0, remaining);
      outputBytes += selected.byteLength;
      if (selected.byteLength < chunk.byteLength) {
        truncated = true;
        stop();
      }
      return current + selected.toString("utf8");
    };
    child.stdout.on("data", (chunk: Buffer): void => {
      stdout = collect(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer): void => {
      stderr = collect(stderr, chunk);
    });
    const timeout = setTimeout((): void => {
      timedOut = true;
      stop();
    }, 10_000);
    timeout.unref();
    const abort = (): void => {
      cancelled = true;
      stop();
    };
    signal.addEventListener("abort", abort, { once: true });
    const cleanup = (): void => {
      clearTimeout(timeout);
      if (forceTimer !== undefined) clearTimeout(forceTimer);
      signal.removeEventListener("abort", abort);
    };
    child.once("error", (error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.once("close", (exitCode): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ exitCode, stdout, stderr, timedOut, truncated, cancelled });
    });
  });
}

interface PreparedInvocation {
  readonly invocation: ValidationInvocation;
  readonly pathMappings: readonly (readonly [staged: string, source: string])[];
}

async function prepareInvocation(
  invocation: ValidationInvocation,
  temporaryRoot: string,
  signal: AbortSignal,
): Promise<PreparedInvocation> {
  const staging = invocation.staging;
  if (staging === undefined || signal.aborted) {
    return { invocation, pathMappings: [] };
  }
  const sourceRoot = resolve(staging.sourceRoot);
  const sourcePath = resolve(staging.sourcePath);
  const selectedRelative = relative(sourceRoot, sourcePath);
  if (
    selectedRelative === "" ||
    isAbsolute(selectedRelative) ||
    selectedRelative === ".." ||
    selectedRelative.startsWith(".." + sep)
  ) {
    throw new Error("The validation source must be contained by its configuration root.");
  }
  const stagedRoot = join(temporaryRoot, "input");
  const stagedPath = join(stagedRoot, selectedRelative);
  await mkdir(stagedRoot);
  const copied = new Set<string>();
  const budget = { bytes: 0, files: 0 };
  await copyStagedFile(sourcePath, stagedPath, selectedRelative, copied, budget, true);
  await copyRelatedFiles(sourceRoot, stagedRoot, staging.kind, copied, budget, "", 0);
  const remap = (value: string): string => {
    if (value === sourcePath) return stagedPath;
    if (value === sourceRoot) return stagedRoot;
    return value;
  };
  return {
    invocation: {
      ...invocation,
      arguments: invocation.arguments.map(remap),
      cwd: remap(invocation.cwd),
      ...(invocation.environment === undefined
        ? {}
        : {
            environment: Object.fromEntries(
              Object.entries(invocation.environment).map(([key, value]) => [key, remap(value)]),
            ),
          }),
    },
    pathMappings: [
      [stagedPath, sourcePath],
      [stagedRoot, sourceRoot],
    ],
  };
}

async function copyRelatedFiles(
  sourceRoot: string,
  stagedRoot: string,
  kind: ValidationKind,
  copied: Set<string>,
  budget: { bytes: number; files: number },
  relativeDirectory: string,
  depth: number,
): Promise<void> {
  if (depth > maximumDepth(kind)) return;
  const sourceDirectory = join(sourceRoot, relativeDirectory);
  let entries;
  try {
    entries = await readdir(sourceDirectory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = join(relativeDirectory, entry.name);
    const sourcePath = join(sourceRoot, relativePath);
    if (entry.isDirectory() && shouldDescend(kind, relativePath, depth)) {
      await copyRelatedFiles(sourceRoot, stagedRoot, kind, copied, budget, relativePath, depth + 1);
      continue;
    }
    if (!entry.isFile() || !isRelatedConfiguration(kind, relativePath)) continue;
    const metadata = await lstat(sourcePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
    await copyStagedFile(
      sourcePath,
      join(stagedRoot, relativePath),
      relativePath,
      copied,
      budget,
      false,
    );
  }
}

async function copyStagedFile(
  sourcePath: string,
  stagedPath: string,
  relativePath: string,
  copied: Set<string>,
  budget: { bytes: number; files: number },
  required: boolean,
): Promise<void> {
  if (copied.has(relativePath)) return;
  const metadata = await stat(sourcePath);
  if (!metadata.isFile()) throw new Error("Installed validation requires a regular source file.");
  if (metadata.size > maximumStagedFileBytes) {
    if (!required) return;
    throw new Error("The validation source exceeds the 2 MiB staging limit.");
  }
  if (budget.files >= maximumStagedFiles || budget.bytes + metadata.size > maximumStagedBytes) {
    if (!required) return;
    throw new Error("The validation source exceeds the staging budget.");
  }
  await mkdir(dirname(stagedPath), { recursive: true });
  await copyFile(sourcePath, stagedPath);
  await chmod(stagedPath, 0o600);
  copied.add(relativePath);
  budget.files += 1;
  budget.bytes += metadata.size;
}

async function applyCapabilityPolicy(
  invocation: ValidationInvocation,
  signal: AbortSignal,
  privateRoot: string,
): Promise<ValidationInvocation> {
  const kind = invocation.capabilityPolicy;
  if (kind === undefined || signal.aborted) return invocation;
  const helpArgument = kind === "quadlet" ? "-h" : "--help";
  const help = await runProcess(
    {
      executable: invocation.executable,
      arguments: [helpArgument],
      cwd: invocation.cwd,
      label: invocation.label + " capability probe",
    },
    signal,
    privateRoot,
  );
  if (help.cancelled) return invocation;
  const helpOutput = requiredProbeOutput(help, invocation.label + " capability probe");
  let versionOutput: string | undefined;
  if (kind === "mkosi") {
    const version = await runProcess(
      {
        executable: invocation.executable,
        arguments: ["--version"],
        cwd: invocation.cwd,
        label: invocation.label + " version probe",
      },
      signal,
      privateRoot,
    );
    if (version.cancelled) return invocation;
    versionOutput = requiredProbeOutput(version, invocation.label + " version probe");
  }
  return hardenInvocationForCapabilities(invocation, kind, helpOutput, versionOutput);
}

export function hardenInvocationForCapabilities(
  invocation: ValidationInvocation,
  kind: ValidationKind,
  helpOutput: string,
  versionOutput?: string,
): ValidationInvocation {
  if (kind === "quadlet" && !/(?:^|\s)-dryrun(?:\s|$)/u.test(helpOutput)) {
    throw new Error("The installed Quadlet generator does not advertise safe -dryrun support.");
  }
  if (kind === "mkosi") {
    if (
      !helpOutput.includes("--directory") ||
      !helpOutput.includes("--no-pager") ||
      !/\bsummary\b/u.test(helpOutput)
    ) {
      throw new Error(
        "The installed mkosi does not advertise the safe non-paging summary interface.",
      );
    }
    const major = /\bmkosi\s+v?(\d+)(?:\.\d+)*\b/iu.exec(versionOutput ?? "")?.[1];
    const parsedMajor = major === undefined ? undefined : Number(major);
    if (
      parsedMajor === undefined ||
      parsedMajor < oldestAuditedMkosiMajor ||
      parsedMajor > newestAuditedMkosiMajor
    ) {
      throw new Error(
        "Installed mkosi validation is available only for source-audited versions 16 through 26.",
      );
    }
  }
  if (kind !== "systemd-unit") return invocation;
  if (!helpOutput.includes("--man") || !helpOutput.includes("--generators")) {
    throw new Error(
      "The installed systemd-analyze does not advertise the required safe verification flags.",
    );
  }
  const safeOptions = ["--man=no", "--generators=no"];
  if (helpOutput.includes("--recursive-errors")) safeOptions.push("--recursive-errors=no");
  return {
    ...invocation,
    arguments: [...safeOptions, ...invocation.arguments],
    environment: {
      ...invocation.environment,
      SYSTEMD_ENVIRONMENT_GENERATOR_PATH: "",
      SYSTEMD_GENERATOR_PATH: "",
      SYSTEMD_UNIT_PATH: invocation.cwd,
    },
  };
}

function requiredProbeOutput(result: ProcessResult, label: string): string {
  if (result.timedOut) throw new Error(label + " timed out.");
  if (result.truncated) throw new Error(label + " exceeded the output limit.");
  if (result.exitCode !== 0) throw new Error(label + " exited unsuccessfully.");
  return result.stdout + "\n" + result.stderr;
}

function validatorEnvironment(
  privateRoot: string,
  additions: Readonly<Record<string, string>> | undefined,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "ComSpec",
    "COMSPEC",
  ]) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  environment["HOME"] = join(privateRoot, "home");
  environment["USERPROFILE"] = join(privateRoot, "home");
  environment["TMPDIR"] = join(privateRoot, "tmp");
  environment["TMP"] = join(privateRoot, "tmp");
  environment["TEMP"] = join(privateRoot, "tmp");
  environment["XDG_CACHE_HOME"] = join(privateRoot, "xdg-cache");
  environment["XDG_CONFIG_HOME"] = join(privateRoot, "xdg-config");
  environment["XDG_DATA_HOME"] = join(privateRoot, "xdg-data");
  environment["LANG"] = "C";
  environment["LC_ALL"] = "C";
  environment["SYSTEMD_COLORS"] = "0";
  environment["SYSTEMD_LOG_COLOR"] = "0";
  environment["SYSTEMD_PAGER"] = "cat";
  return { ...environment, ...additions };
}

function remapResult(
  result: ProcessResult,
  mappings: readonly (readonly [staged: string, source: string])[],
  temporaryRoot: string,
): ProcessResult {
  const remap = (value: string): string => {
    let updated = value;
    for (const [staged, source] of mappings) updated = updated.replaceAll(staged, source);
    return updated.replaceAll(temporaryRoot, "<validation>");
  };
  return { ...result, stdout: remap(result.stdout), stderr: remap(result.stderr) };
}

function configurationRoot(kind: ValidationKind, configurationPath: string): string {
  let directory = dirname(resolve(configurationPath));
  if (kind !== "mkosi") {
    return basename(directory).endsWith(".d") ? dirname(directory) : directory;
  }
  for (let depth = 0; depth < 8; depth += 1) {
    if (mkosiConfigurationDirectories.has(basename(directory))) return dirname(directory);
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return dirname(resolve(configurationPath));
}

const mkosiConfigurationDirectories = new Set([
  "mkosi.conf.d",
  "mkosi.images",
  "mkosi.initrd.conf",
  "mkosi.local",
  "mkosi.profiles",
  "mkosi.tools.conf",
  "mkosi.uki-profiles",
]);

function maximumDepth(kind: ValidationKind): number {
  return kind === "mkosi" ? 5 : 2;
}

function shouldDescend(kind: ValidationKind, relativePath: string, depth: number): boolean {
  const first = relativePath.split(sep)[0] ?? "";
  if (kind === "mkosi") return mkosiConfigurationDirectories.has(first);
  return depth === 0 && first.endsWith(".d");
}

function isRelatedConfiguration(kind: ValidationKind, relativePath: string): boolean {
  const normalized = relativePath.replaceAll(sep, "/");
  if (kind === "systemd-unit") {
    return (
      /\.(?:service|socket|timer|path|mount|automount|swap|target|device|slice|scope)$/u.test(
        normalized,
      ) ||
      /\.(?:service|socket|timer|path|mount|automount|swap|target|device|slice|scope)\.d\/[^/]+\.conf$/u.test(
        normalized,
      )
    );
  }
  if (kind === "quadlet") {
    return (
      /\.(?:artifact|build|container|image|kube|network|pod|volume)$/u.test(normalized) ||
      /\.(?:artifact|build|container|image|kube|network|pod|volume)\.d\/[^/]+\.conf$/u.test(
        normalized,
      )
    );
  }
  const first = normalized.split("/")[0] ?? "";
  return (
    /^(?:mkosi\.conf|mkosi\.local\.conf|mkosi\.tools\.conf|mkosi\.version)$/u.test(normalized) ||
    (mkosiConfigurationDirectories.has(first) && /(?:^|\/)[^/]+\.conf$/u.test(normalized))
  );
}

function terminate(
  pid: number | undefined,
  kill: (signal?: NodeJS.Signals | number) => boolean,
): ReturnType<typeof setTimeout> {
  if (pid !== undefined && process.platform !== "win32") {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      kill("SIGTERM");
    }
  } else {
    kill("SIGTERM");
  }
  const force = setTimeout((): void => {
    try {
      if (pid !== undefined && process.platform !== "win32") process.kill(-pid, "SIGKILL");
      else kill("SIGKILL");
    } catch {
      // The process already exited.
    }
  }, 500);
  force.unref();
  return force;
}

function emptyResult(cancelled: boolean): ProcessResult {
  return {
    exitCode: null,
    stdout: "",
    stderr: "",
    timedOut: false,
    truncated: false,
    cancelled,
  };
}
