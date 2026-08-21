import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
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
    { width: 1512, height: 780, label: "14-inch MacBook Pro browser window" },
    { width: 1280, height: 720, label: "compact laptop" },
    { width: 1024, height: 640, label: "small laptop window" },
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
      measurements.dialog.left >= 16 && measurements.dialog.top >= 16,
      viewport.label + " dialog lacks comfortable viewport margins",
    );
    assert(
      measurements.dialog.right <= viewport.width + 1,
      viewport.label + " dialog exceeds the viewport width",
    );
    assert(
      measurements.dialog.bottom <= viewport.height + 1,
      viewport.label + " dialog exceeds the viewport height",
    );
    assert(
      measurements.dialog.right <= viewport.width - 16 &&
        measurements.dialog.bottom <= viewport.height - 16,
      viewport.label + " dialog lacks comfortable viewport margins",
    );
    assert(
      measurements.dialog.right - measurements.dialog.left <= 864 + 1,
      viewport.label + " dialog is wider than the documented maximum",
    );
    assert(
      measurements.dialog.bottom - measurements.dialog.top <=
        Math.min(viewport.height * 0.76, 672) + 1,
      viewport.label + " dialog is taller than the documented maximum",
    );
    assert(
      measurements.dialog.scrollHeight <= measurements.dialog.clientHeight + 1,
      viewport.label + " dialog requires scrolling: " + JSON.stringify(measurements),
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
    const contents = await readFile(file);
    response.writeHead(200, { "content-type": contentType(file) });
    response.end(contents);
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
