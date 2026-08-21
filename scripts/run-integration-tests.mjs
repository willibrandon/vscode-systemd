import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { runTests } from "@vscode/test-electron";

const root = resolve(import.meta.dirname, "..");

if (process.platform === "linux" && process.env.SYSTEMD_TEST_XVFB !== "1") {
  const child = spawnSync(
    "xvfb-run",
    ["-a", process.execPath, resolve(import.meta.dirname, "run-integration-tests.mjs")],
    {
      cwd: root,
      env: { ...process.env, SYSTEMD_TEST_XVFB: "1" },
      stdio: "inherit",
    },
  );
  process.exit(child.status ?? 1);
}

const userData = await mkdtemp(resolve(tmpdir(), "vscode-systemd-integration-"));

try {
  await runTests({
    version: process.env.VSCODE_TEST_VERSION ?? "1.102.0",
    extensionDevelopmentPath: root,
    extensionTestsPath: resolve(root, "test/integration/suite/index.cjs"),
    launchArgs: [
      resolve(root, "test/integration/fixtures"),
      "--disable-extensions",
      "--disable-workspace-trust",
      "--skip-release-notes",
      "--skip-welcome",
      "--user-data-dir=" + userData,
    ],
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await rm(userData, { recursive: true, force: true });
}
