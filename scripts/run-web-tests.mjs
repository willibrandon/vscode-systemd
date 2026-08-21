import { runTests } from "@vscode/test-web";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

await runTests({
  browserType: "chromium",
  extensionDevelopmentPath: root,
  extensionTestsPath: resolve(root, "dist/test/web/index.cjs"),
  folderPath: resolve(root, "test/integration/fixtures"),
  headless: true,
  quality: process.env.VSCODE_WEB_QUALITY === "insiders" ? "insiders" : "stable",
  testRunnerDataDir: resolve(root, ".vscode-test-web/runtime"),
});

process.stdout.write("VS Code web extension tests passed.\n");
