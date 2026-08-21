import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { chromium } from "playwright";

const root = resolve(import.meta.dirname, "..");
const site = resolve(root, "docs-site/dist");
const base = "/vscode-systemd";
const docsConfiguration = await readFile(resolve(root, "docs-site/astro.config.mjs"), "utf8");
const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const contributedGrammars = new Map(
  manifest.contributes.grammars
    .filter(({ language }) => language !== undefined)
    .map(({ language, path }) => [language, path.replace(/^\.\//u, "")]),
);
for (const [language, grammar] of [
  ["systemd-unit", "syntaxes/systemd.tmLanguage.json"],
  ["podman-quadlet", "syntaxes/quadlet.tmLanguage.json"],
  ["mkosi", "syntaxes/mkosi.tmLanguage.json"],
]) {
  assert(
    contributedGrammars.get(language) === grammar,
    language + " does not contribute the expected packaged grammar",
  );
  assert(
    docsConfiguration.includes('from "../' + grammar + '"'),
    language + " documentation examples do not import the packaged grammar directly",
  );
}
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
  const viewports = [
    { width: 3840, height: 2160, label: "4K Windows monitor" },
    { width: 2560, height: 1440, label: "large Windows monitor" },
    { width: 1920, height: 1080, label: "full HD Windows monitor" },
    {
      width: 1536,
      height: 864,
      deviceScaleFactor: 1.25,
      label: "scaled Windows monitor",
    },
    { width: 1512, height: 720, label: "14-inch MacBook Pro browser window" },
    { width: 1024, height: 600, label: "small laptop window" },
    { width: 390, height: 844, label: "phone portrait" },
    { width: 844, height: 390, label: "phone landscape" },
  ];
  const routes = ["/", "/editing/", "/effective-configuration/"];

  for (const viewport of viewports) {
    for (const route of routes) {
      const page = await browser.newPage({
        deviceScaleFactor: viewport.deviceScaleFactor ?? 1,
        viewport: { width: viewport.width, height: viewport.height },
      });
      await page.goto(`http://127.0.0.1:${address.port}${base}${route}`);
      const sources = page.locator(".sl-markdown-content img[data-image-zoom]");
      const imageCount = await sources.count();
      assert(imageCount > 0, route + " has no popup image to verify");

      for (let imageIndex = 0; imageIndex < imageCount; imageIndex += 1) {
        await sources.nth(imageIndex).click();

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
          const root = element.ownerDocument.documentElement;
          return {
            documentOverflow:
              element.ownerDocument.defaultView?.getComputedStyle(root).overflow ?? "",
            rootFontSize: Number.parseFloat(
              element.ownerDocument.defaultView?.getComputedStyle(root).fontSize ?? "16",
            ),
            zoomScrollLock: root.hasAttribute("data-image-zoom-open"),
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
              height: imageBounds.height,
              width: imageBounds.width,
              naturalHeight: image.naturalHeight,
              naturalWidth: image.naturalWidth,
              sizes: image.sizes,
            },
            captionBottom: captionBounds?.bottom ?? 0,
          };
        });

        const context = `${viewport.label} ${route} image ${imageIndex + 1}`;
        const maximumImageWidth = Math.min(
          measurements.image.naturalWidth,
          viewport.width - 4 * measurements.rootFontSize,
          80 * measurements.rootFontSize,
        );
        const maximumImageHeight = Math.min(
          measurements.image.naturalHeight,
          viewport.height - 9 * measurements.rootFontSize,
        );
        const imageScale = Math.min(
          1,
          maximumImageWidth / measurements.image.naturalWidth,
          maximumImageHeight / measurements.image.naturalHeight,
        );
        const expectedImageWidth = measurements.image.naturalWidth * imageScale;
        const expectedImageHeight = measurements.image.naturalHeight * imageScale;
        assert(measurements.dialog.top >= 0, context + " dialog starts above the viewport");
        assert(
          measurements.dialog.left >= 16 && measurements.dialog.top >= 16,
          context + " dialog lacks comfortable viewport margins",
        );
        assert(
          measurements.dialog.right <= viewport.width + 1,
          context + " dialog exceeds the viewport width",
        );
        assert(
          measurements.dialog.bottom <= viewport.height + 1,
          context + " dialog exceeds the viewport height",
        );
        assert(
          measurements.dialog.right <= viewport.width - 16 &&
            measurements.dialog.bottom <= viewport.height - 16,
          context + " dialog lacks comfortable viewport margins",
        );
        assert(
          Math.abs(measurements.image.width - expectedImageWidth) <= 2 &&
            Math.abs(measurements.image.height - expectedImageHeight) <= 2,
          context +
            " does not use the largest natural image size that fits the viewport: " +
            JSON.stringify(measurements),
        );
        assert(
          measurements.image.sizes === "(max-width: 84rem) calc(100vw - 4rem), 80rem",
          context + " does not request an appropriately sized responsive image",
        );
        assert(
          measurements.dialog.scrollHeight <= measurements.dialog.clientHeight + 1,
          context + " dialog requires scrolling: " + JSON.stringify(measurements),
        );
        assert(
          measurements.frame.scrollHeight <= measurements.frame.clientHeight + 1,
          context + " image frame requires scrolling",
        );
        assert(
          measurements.image.left >= measurements.dialog.left &&
            measurements.image.right <= measurements.dialog.right + 1 &&
            measurements.image.top >= measurements.dialog.top &&
            measurements.image.bottom <= measurements.dialog.bottom + 1,
          context + " expanded image is clipped",
        );
        assert(
          measurements.captionBottom <= measurements.dialog.bottom + 1,
          context + " caption is clipped",
        );
        assert(
          measurements.documentOverflow === "hidden",
          context + " leaves the documentation page scrollable behind the popup",
        );
        assert(measurements.zoomScrollLock, context + " did not activate its page scroll lock");
        await dialog.locator("[data-close]").click();
        await dialog.waitFor({ state: "hidden" });
        assert(
          !(await page
            .locator("html")
            .evaluate((element) => element.hasAttribute("data-image-zoom-open"))),
          context + " did not release its page scroll lock after close",
        );
      }
      await page.close();
    }
  }
  console.log(
    "Documentation examples use the exact packaged grammars, and every image popup uses the largest natural size that fits desktop, laptop, and mobile viewports without scrolling.",
  );
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
