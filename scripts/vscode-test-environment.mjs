export function createIsolatedVSCodeEnvironment(environment = process.env) {
  const isolated = { ...environment, DONT_PROMPT_WSL_INSTALL: "1" };
  delete isolated.VSCODE_IPC_HOOK_CLI;
  return isolated;
}
