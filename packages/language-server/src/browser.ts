import {
  BrowserMessageReader,
  BrowserMessageWriter,
  createConnection,
} from "vscode-languageserver/browser";
import { startLanguageServer } from "./server.js";

const messageReader = new BrowserMessageReader(self);
const messageWriter = new BrowserMessageWriter(self);

startLanguageServer(createConnection(messageReader, messageWriter), {
  setTimeout(callback, milliseconds) {
    return globalThis.setTimeout(callback, milliseconds);
  },
  clearTimeout(handle) {
    globalThis.clearTimeout(handle as number);
  },
});
