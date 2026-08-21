import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { chromium } from "playwright";

const root = resolve(import.meta.dirname, "..");
const site = resolve(root, "docs-site/dist");
const base = "/vscode-systemd";
const server = createServer((request, response) => {
  void serve(request.url ?? "/", response);
});

await new Promise((resolvePromise, rejectPromise) => {
  server.once("error", rejectPromise);
  server.listen(0, "127.0.0.1", resolvePromise);
});

const address = server.address();
if (address === null || typeof address === "string") throw new Error("Docs server did not bind.");

const browser = await chromium.launch({ headless: true });
try {
  for (const viewport of [
    { width: 1512, height: 850, label: "14-inch MacBook Pro" },
    { width: 1280, height: 720, label: "compact laptop" },
  ]) {
    const page = await browser.newPage({
      viewport: { width: viewport.width, height: viewport.height },
    });
    await page.goto(`http://127.0.0.1:${address.port}${base}/editing/`);
    const source = page.locator(".sl-markdown-content img[data-image-zoom]").first();
    await source.click();

    const dialog = page.locator("docs-image-zoom dialog[open]");
    await dialog.waitFor({ state: "visible" });
    await dialog.locator("img").evaluate(async (image) => {
      if (image.complete && image.naturalWidth > 0) return;
      await new Promise((resolvePromise, rejectPromise) => {
        image.addEventListener("load", resolvePromise, { once: true });
        image.addEventListener("error", rejectPromise, { once: true });
      });
    });

    const measurements = await dialog.evaluate((element) => {
      const frame = element.querySelector(".image-frame");
      const image = element.querySelector("img");
      const caption = element.querySelector("[data-caption]");
      if (frame === null || image === null) {
        throw new Error("Expanded-image frame is incomplete.");
      }
      const dialogBounds = element.getBoundingClientRect();
      const imageBounds = image.getBoundingClientRect();
      const captionBounds = caption?.getBoundingClientRect();
      return {
        dialog: {
          top: dialogBounds.top,
          right: dialogBounds.right,
          bottom: dialogBounds.bottom,
          left: dialogBounds.left,
          clientHeight: element.clientHeight,
          scrollHeight: element.scrollHeight,
        },
        frame: { clientHeight: frame.clientHeight, scrollHeight: frame.scrollHeight },
        image: {
          top: imageBounds.top,
          right: imageBounds.right,
          bottom: imageBounds.bottom,
          left: imageBounds.left,
        },
        captionBottom: captionBounds?.bottom ?? 0,
      };
    });

    assert(measurements.dialog.top >= 0, viewport.label + " dialog starts above the viewport");
    assert(
      measurements.dialog.right <= viewport.width + 1,
      viewport.label + " dialog exceeds the viewport width",
    );
    assert(
      measurements.dialog.bottom <= viewport.height + 1,
      viewport.label + " dialog exceeds the viewport height",
    );
    assert(
      measurements.dialog.scrollHeight <= measurements.dialog.clientHeight + 1,
      viewport.label + " dialog requires scrolling",
    );
    assert(
      measurements.frame.scrollHeight <= measurements.frame.clientHeight + 1,
      viewport.label + " image frame requires scrolling",
    );
    assert(
      measurements.image.left >= measurements.dialog.left &&
        measurements.image.right <= measurements.dialog.right + 1 &&
        measurements.image.top >= measurements.dialog.top &&
        measurements.image.bottom <= measurements.dialog.bottom + 1,
      viewport.label + " expanded image is clipped",
    );
    assert(
      measurements.captionBottom <= measurements.dialog.bottom + 1,
      viewport.label + " caption is clipped",
    );
    await page.close();
  }
  console.log("Documentation image popup fits laptop viewports without scrolling.");
} finally {
  await browser.close();
  await new Promise((resolvePromise, rejectPromise) => {
    server.close((error) => (error === undefined ? resolvePromise() : rejectPromise(error)));
  });
}

async function serve(requestUrl, response) {
  try {
    const pathname = decodeURIComponent(new URL(requestUrl, "http://localhost").pathname);
    let relative = pathname.startsWith(base) ? pathname.slice(base.length) : pathname;
    if (relative.endsWith("/")) relative += "index.html";
    const file = resolve(site, "." + relative);
    if (file !== site && !file.startsWith(site + sep)) throw new Error("Invalid docs path.");
    if (!(await stat(file)).isFile()) throw new Error("Docs path is not a file.");
    response.writeHead(200, { "content-type": contentType(file) });
    response.end(await readFile(file));
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}

function contentType(file) {
  switch (extname(file)) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".png":
      return "image/png";
    case ".svg":
      return "image/svg+xml";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
