import { createConnection, ProposedFeatures } from "vscode-languageserver/node";
import { startLanguageServer } from "./server.js";

startLanguageServer(createConnection(ProposedFeatures.all), {
  setTimeout(callback, milliseconds) {
    return setTimeout(callback, milliseconds);
  },
  clearTimeout(handle) {
    clearTimeout(handle as NodeJS.Timeout);
  },
});
