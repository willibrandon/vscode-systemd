import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import starlight from "@astrojs/starlight";
import systemdGrammar from "../syntaxes/systemd.tmLanguage.json" with { type: "json" };
import quadletGrammar from "../syntaxes/quadlet.tmLanguage.json" with { type: "json" };
import mkosiGrammar from "../syntaxes/mkosi.tmLanguage.json" with { type: "json" };

const languages = [
  { ...systemdGrammar, name: "systemd" },
  { ...quadletGrammar, name: "quadlet" },
  { ...mkosiGrammar, name: "mkosi" },
];

export default defineConfig({
  site: "https://willibrandon.github.io",
  base: "/vscode-systemd",
  trailingSlash: "always",
  publicDir: "../media",
  integrations: [
    starlight({
      title: "systemd Unit Files",
      description: "VS Code support for systemd, Podman Quadlet, and mkosi.",
      favicon: "/icon.png",
      customCss: ["./src/styles/docs.css"],
      credits: false,
      components: {
        MarkdownContent: "./src/components/MarkdownContent.astro",
      },
      expressiveCode: {
        shiki: {
          langs: languages,
        },
      },
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/willibrandon/vscode-systemd",
        },
      ],
      sidebar: [
        { slug: "", label: "Overview" },
        { slug: "getting-started" },
        { slug: "recognized-files" },
        { slug: "editing" },
        { slug: "effective-configuration" },
        { slug: "validation" },
        { slug: "settings" },
        { slug: "commands" },
        { slug: "privacy-and-trust" },
        { slug: "troubleshooting" },
      ],
    }),
    sitemap(),
  ],
});
