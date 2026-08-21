import { runTests, runVSCodeCommand } from "@vscode/test-electron";
import { resolve } from "node:path";
import { createIsolatedVSCodeEnvironment } from "./vscode-test-environment.mjs";

export async function runInstalledDesktopSmoke(options) {
  const { expectedIdentity, extensionsDirectory, installTarget, root, userDataDirectory, version } =
    options;
  const commandEnvironment = createIsolatedVSCodeEnvironment();
  const profileArguments = [
    `--extensions-dir=${extensionsDirectory}`,
    `--user-data-dir=${userDataDirectory}`,
  ];
  const installation = await runVSCodeCommand(
    ["--install-extension", installTarget, "--force", ...profileArguments],
    { spawn: { env: commandEnvironment }, version },
  );
  process.stdout.write(installation.stdout);
  process.stderr.write(installation.stderr);

  const listing = await runVSCodeCommand(
    ["--list-extensions", "--show-versions", ...profileArguments],
    { spawn: { env: commandEnvironment }, version },
  );
  const installed = listing.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean);
  if (!installed.includes(expectedIdentity.toLowerCase())) {
    throw new Error(
      `Clean profile contains ${JSON.stringify(installed)}, expected ${expectedIdentity}.`,
    );
  }

  await runTests({
    version,
    extensionDevelopmentPath: resolve(root, "test/package/host"),
    extensionTestsPath: resolve(root, "test/integration/suite/index.cjs"),
    extensionTestsEnv: {
      ...commandEnvironment,
      SYSTEMD_EXPECTED_INSTALLED_EXTENSION_PATH_PREFIX: extensionsDirectory,
      SYSTEMD_EXPECTED_INSTALLED_EXTENSION_VERSION: expectedIdentity.slice(
        expectedIdentity.lastIndexOf("@") + 1,
      ),
    },
    launchArgs: [
      resolve(root, "test/integration/fixtures"),
      "--disable-workspace-trust",
      "--skip-release-notes",
      "--skip-welcome",
      ...profileArguments,
    ],
  });
}
