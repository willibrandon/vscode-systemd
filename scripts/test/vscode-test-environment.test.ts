import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

interface TestEnvironmentModule {
  readonly createIsolatedVSCodeEnvironment: (
    environment: Readonly<Record<string, string>>,
  ) => Record<string, string>;
}

const moduleUrl = pathToFileURL(resolve(import.meta.dirname, "../vscode-test-environment.mjs"));
const testEnvironment = (await import(moduleUrl.href)) as TestEnvironmentModule;

describe("isolated VS Code test environment", () => {
  it("prevents an integrated terminal from redirecting the downloaded CLI", () => {
    const integratedTerminalEnvironment = {
      PATH: "/vscode/bin/remote-cli:/usr/local/bin:/usr/bin",
      VSCODE_IPC_HOOK_CLI: "/tmp/vscode-ipc.sock",
      WORKSPACE: "/workspaces/vscode-systemd",
    };

    const isolated = testEnvironment.createIsolatedVSCodeEnvironment(integratedTerminalEnvironment);

    expect(isolated).toEqual({
      DONT_PROMPT_WSL_INSTALL: "1",
      PATH: integratedTerminalEnvironment.PATH,
      WORKSPACE: integratedTerminalEnvironment.WORKSPACE,
    });
    expect(integratedTerminalEnvironment.VSCODE_IPC_HOOK_CLI).toBe("/tmp/vscode-ipc.sock");
  });
});
