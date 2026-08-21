import { execFile } from "node:child_process";
import process from "node:process";

export type TargetEcosystem = "systemd" | "podman" | "mkosi";

export interface VersionProbe {
  readonly ecosystem: TargetEcosystem;
  readonly executable: string;
}

export type DetectedVersions = Partial<Readonly<Record<TargetEcosystem, string>>>;

export async function detectInstalledVersions(
  probes: readonly VersionProbe[],
): Promise<DetectedVersions> {
  const unique = new Map(probes.map((probe) => [probe.ecosystem + "\0" + probe.executable, probe]));
  const detected = await Promise.all(
    [...unique.values()].map(
      async (probe): Promise<readonly [TargetEcosystem, string] | undefined> => {
        const output = await versionOutput(probe.executable);
        const version =
          output === undefined ? undefined : parseInstalledVersion(probe.ecosystem, output);
        return version === undefined ? undefined : [probe.ecosystem, version];
      },
    ),
  );
  const result: Partial<Record<TargetEcosystem, string>> = {};
  for (const entry of detected) {
    if (entry === undefined) continue;
    const [ecosystem, version] = entry;
    const current = result[ecosystem];
    if (current === undefined || compareVersions(version, current) < 0) result[ecosystem] = version;
  }
  return result;
}

export function parseInstalledVersion(
  ecosystem: TargetEcosystem,
  output: string,
): string | undefined {
  const pattern =
    ecosystem === "systemd"
      ? /\bsystemd\s+v?(\d+(?:\.\d+)*)/iu
      : ecosystem === "podman"
        ? /\bpodman(?:\s+version)?\s+v?(\d+(?:\.\d+)*)/iu
        : /\bmkosi\s+v?(\d+(?:\.\d+)*)/iu;
  return pattern.exec(output)?.[1];
}

function versionOutput(executable: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      executable,
      ["--version"],
      {
        encoding: "utf8",
        env: probeEnvironment(),
        maxBuffer: 256 * 1024,
        timeout: 2_000,
        windowsHide: true,
      },
      (error, stdout, stderr): void => {
        const output = stdout + stderr;
        resolve(error !== null && output.trim() === "" ? undefined : output);
      },
    );
  });
}

function probeEnvironment(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {
    LANG: "C",
    LC_ALL: "C",
    NO_COLOR: "1",
    SYSTEMD_COLORS: "0",
  };
  for (const name of ["PATH", "PATHEXT", "SystemRoot", "WINDIR"] as const) {
    const value = process.env[name];
    if (value !== undefined) result[name] = value;
  }
  return result;
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
