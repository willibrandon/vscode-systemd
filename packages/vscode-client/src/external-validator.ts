import { spawn } from "node:child_process";
import type { SpawnOptionsWithoutStdio } from "node:child_process";
import { dirname } from "node:path";
import process from "node:process";

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
    return {
      executable: executables.systemdAnalyze,
      arguments: ["verify", configurationPath],
      cwd: dirname(configurationPath),
      label: "systemd-analyze verify",
    };
  }
  if (languageId === "podman-quadlet") {
    return {
      executable: executables.quadletGenerator,
      arguments: ["-dryrun"],
      cwd: dirname(configurationPath),
      label: "Quadlet generator dry run",
      environment: { QUADLET_UNIT_DIRS: dirname(configurationPath) },
    };
  }
  if (languageId === "mkosi") {
    return {
      executable: executables.mkosi,
      arguments: ["--directory", dirname(configurationPath), "summary"],
      cwd: dirname(configurationPath),
      label: "mkosi summary",
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
  const result = await runProcess(invocation, signal);
  if (!isTrusted()) throw new Error("Workspace trust was revoked during installed validation.");
  return { label: invocation.label, ...result };
}

function runProcess(invocation: ValidationInvocation, signal: AbortSignal): Promise<ProcessResult> {
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
      env: { ...process.env, ...invocation.environment },
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
