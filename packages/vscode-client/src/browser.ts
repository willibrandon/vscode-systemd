import * as vscode from "vscode";
import { LanguageClient } from "vscode-languageclient/browser";
import { clientOptions, registerCommonFeatures } from "./common.js";

let client: LanguageClient | undefined;
let serverWorker: Worker | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("systemd Language Server", { log: true });
  const server = vscode.Uri.joinPath(context.extensionUri, "dist", "browserServer.js");
  const worker = new Worker(server.toString(true), { name: "systemd Language Server" });
  serverWorker = worker;
  client = new LanguageClient("systemd", "systemd Language Server", worker, clientOptions(output));
  const languageClient = client;
  context.subscriptions.push(output, languageClient);
  await languageClient.start();
  const features = registerCommonFeatures(context, { client: languageClient, output });
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "systemd.validateWithInstalledTools",
      async (): Promise<void> => {
        await vscode.window.showInformationMessage(
          "Installed validators are unavailable in a browser extension host; internal validation remains active.",
        );
      },
    ),
  );
  await features.refreshIndex();
  await vscode.commands.executeCommand("setContext", "systemd.externalValidationAvailable", false);
  output.info("systemd language server started in a Web Worker.");
}

export async function deactivate(): Promise<void> {
  await client?.stop();
  serverWorker?.terminate();
  client = undefined;
  serverWorker = undefined;
}
