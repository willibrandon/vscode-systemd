import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { downloadAndUnzipVSCode, runVSCodeCommand } from "@vscode/test-electron";
import { chromium } from "playwright";
import { createIsolatedVSCodeEnvironment } from "./vscode-test-environment.mjs";

const root = resolve(import.meta.dirname, "..");

if (process.platform === "linux" && process.env.SYSTEMD_DOCS_XVFB !== "1") {
  const child = spawnSync(
    "xvfb-run",
    ["-a", process.execPath, resolve(import.meta.dirname, "capture-docs-screenshots.mjs")],
    {
      cwd: root,
      env: { ...process.env, SYSTEMD_DOCS_XVFB: "1" },
      stdio: "inherit",
    },
  );
  process.exit(child.status ?? 1);
}

const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const vsix = resolve(root, `dist/systemd-${manifest.version}.vsix`);
const version = process.env.VSCODE_VERSION ?? "stable";
const outputDirectory = resolve(root, "docs-site/src/assets");
const fixtures = resolve(root, "test/integration/fixtures");
const temporaryRoot = await mkdtemp(join(tmpdir(), "vscode-systemd-docs-"));
const extensionsDirectory = resolve(temporaryRoot, "extensions");
const userDataDirectory = resolve(temporaryRoot, "user-data");
const environment = createIsolatedVSCodeEnvironment();
const port = await availablePort();
let browser;
let code;

await Promise.all([
  mkdir(outputDirectory, { recursive: true }),
  mkdir(extensionsDirectory),
  mkdir(userDataDirectory),
]);
await mkdir(resolve(userDataDirectory, "User"));
await writeFile(
  resolve(userDataDirectory, "User/settings.json"),
  JSON.stringify(
    {
      "git.openRepositoryInParentFolders": "never",
      "workbench.startupEditor": "none",
    },
    null,
    2,
  ) + "\n",
);

try {
  const installation = await runVSCodeCommand(
    [
      "--install-extension",
      vsix,
      "--force",
      `--extensions-dir=${extensionsDirectory}`,
      `--user-data-dir=${userDataDirectory}`,
    ],
    { spawn: { env: environment }, version },
  );
  process.stdout.write(installation.stdout);
  process.stderr.write(installation.stderr);

  const executable = await downloadAndUnzipVSCode(version);
  code = spawn(
    executable,
    [
      resolve(fixtures, "demo.service"),
      "--folder-uri",
      pathToFileURL(fixtures).href,
      "--disable-workspace-trust",
      "--disable-updates",
      "--disable-gpu",
      "--skip-release-notes",
      "--skip-welcome",
      `--remote-debugging-port=${port}`,
      `--extensions-dir=${extensionsDirectory}`,
      `--user-data-dir=${userDataDirectory}`,
    ],
    {
      cwd: root,
      detached: process.platform !== "win32",
      env: environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );

  browser = await connectToBrowser(port, code);
  const page = await waitForPage(browser, code);

  await page.locator(".monaco-workbench").waitFor({ state: "visible", timeout: 30_000 });
  await page.keyboard.press("Escape");
  await runCommand(page, "View: Toggle Secondary Side Bar Visibility");
  await waitForEditor(page);
  await waitForDiagnostics(page);
  await runCommand(page, "systemd: Focus on Explorer View");
  await expandSystemdExplorer(page);

  await replaceLine(page, 7, "Rest");
  await page.keyboard.press("Control+Space");
  await page
    .locator(".suggest-widget:visible")
    .filter({ hasText: "Restart=" })
    .waitFor({ state: "visible", timeout: 10_000 });
  await capture(page, "completion.png");

  await page.keyboard.press("Escape");
  await replaceLine(page, 7, "Restar=yes");
  await waitForDiagnostics(page);
  const line = activeEditor(page).locator(".view-line").filter({ hasText: "Restar=yes" }).first();
  await line.waitFor({ state: "visible", timeout: 10_000 });
  await line.hover({ position: { x: 34, y: 9 } });
  await page
    .locator(".monaco-hover:visible")
    .filter({ hasText: "Unknown Restar=" })
    .waitFor({ state: "visible", timeout: 10_000 });
  await capture(page, "diagnostic.png");

  await page.keyboard.press("Escape");
  await runCommand(page, "systemd: Show Effective Configuration");
  const effective = activeEditor(page).locator(".view-lines");
  await effective
    .filter({ hasText: "# Effective configuration" })
    .waitFor({ state: "visible", timeout: 10_000 });
  const effectiveText = await effective.innerText();
  if (!effectiveText.includes(`${basename(resolve(fixtures, "demo.service"))}:2`)) {
    throw new Error("Effective-configuration screenshot is missing line-level provenance.");
  }
  await capture(page, "effective-configuration.png");
} finally {
  await browser?.close();
  if (code !== undefined) await terminate(code);
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Unable to allocate a debugging port.");
  }
  await new Promise((resolvePromise, rejectPromise) => {
    server.close((error) => (error === undefined ? resolvePromise() : rejectPromise(error)));
  });
  return address.port;
}

async function connectToBrowser(port, child) {
  const endpoint = `http://127.0.0.1:${port}`;
  let lastError;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Visual Studio Code exited before capture with code ${child.exitCode}.`);
    }
    try {
      return await chromium.connectOverCDP(endpoint);
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }
  throw lastError;
}

async function waitForPage(currentBrowser, child) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const page = currentBrowser.contexts()[0]?.pages()[0];
    if (page !== undefined) return page;
    if (child.exitCode !== null) {
      throw new Error(`Visual Studio Code exited before capture with code ${child.exitCode}.`);
    }
    await delay(100);
  }
  throw new Error("Visual Studio Code did not create a browser page.");
}

function activeEditor(page) {
  return page.locator(".editor-group-container.active .monaco-editor:visible").last();
}

async function waitForEditor(page) {
  await activeEditor(page).locator(".view-lines").waitFor({ state: "visible", timeout: 30_000 });
}

async function waitForDiagnostics(page) {
  await activeEditor(page)
    .locator(".squiggly-warning, .squiggly-error")
    .first()
    .waitFor({ state: "attached", timeout: 30_000 });
}

async function expandSystemdExplorer(page) {
  await page.getByText("systemd: Explorer", { exact: true }).first().waitFor({
    state: "visible",
    timeout: 30_000,
  });
  await page.getByText("Workspace", { exact: true }).first().waitFor({
    state: "visible",
    timeout: 30_000,
  });
  await page.getByText("Quadlet resources", { exact: false }).waitFor({
    state: "visible",
    timeout: 30_000,
  });
}

async function replaceLine(page, number, value) {
  const line = activeEditor(page)
    .locator(".view-line")
    .nth(number - 1);
  await line.click();
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+End");
  await page.keyboard.type(value);
}

async function runCommand(page, label) {
  await page.keyboard.press("F1");
  const input = page.locator(".quick-input-widget:visible input");
  await input.waitFor({ state: "visible", timeout: 10_000 });
  await input.fill(`>${label}`);
  const command = page
    .locator(".quick-input-list .monaco-list-row")
    .filter({ hasText: label })
    .first();
  await command.waitFor({ state: "visible", timeout: 10_000 });
  const commandText = await command.textContent();
  if (!commandText?.includes(label)) {
    throw new Error(`Command Palette did not show the exact command label: ${label}`);
  }
  await command.click();
}

async function capture(page, filename) {
  await page.screenshot({ path: resolve(outputDirectory, filename) });
  process.stdout.write(`Captured docs-site/src/assets/${filename} from the installed VSIX.\n`);
}

function terminate(child) {
  return new Promise((resolvePromise) => {
    if (child.exitCode !== null) {
      resolvePromise();
      return;
    }
    child.once("close", resolvePromise);
    try {
      if (child.pid !== undefined && process.platform !== "win32") {
        process.kill(-child.pid, "SIGTERM");
      } else {
        child.kill("SIGTERM");
      }
    } catch {
      resolvePromise();
    }
  });
}
