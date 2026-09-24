import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitepress";

// The glossary is generated from the repo-root CONTEXT.md, which is the
// file agents update. The gitignored generated file has no git history,
// so give the glossary page the last commit time of the root file.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
let glossaryLastUpdated: number | undefined;
try {
  const seconds = execFileSync(
    "git",
    ["log", "-1", "--format=%ct", "--", "CONTEXT.md"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    },
  ).trim();
  const parsed = Number.parseInt(seconds, 10);
  glossaryLastUpdated = Number.isFinite(parsed) ? parsed * 1000 : undefined;
} catch {
  glossaryLastUpdated = undefined;
}

export default defineConfig({
  title: "pi-extensions",
  // git-based lastUpdated is null for the gitignored generated
  // glossary.md, so the page gets the commit time of CONTEXT.md.
  transformPageData: (pageData) => {
    if (pageData.filePath === "glossary.md" && glossaryLastUpdated !== undefined) {
      return { lastUpdated: glossaryLastUpdated };
    }
  },
  description:
    "A pi package that bundles pi extensions: codegraph, quota, model router, sync, and more.",
  base: "/pi-extensions/",
  // Follow the reader's light/dark preference (built-in themes).
  lastUpdated: true,
  themeConfig: {
    // VitePress 1.x reads theme options from themeConfig, not the top level.
    editLink: {
      // The glossary is generated from the repo-root CONTEXT.md, which is
      // gitignored, so its edit link points at the root file. The function
      // form does not substitute :path (the string form does), so the page
      // path is spliced in here. The URLs stay inline: the function is
      // serialized by VitePress and keeps no closure.
      pattern: (page) =>
        page.filePath === "glossary.md"
          ? "https://github.com/SeriousJul/pi-extensions/edit/main/CONTEXT.md"
          : "https://github.com/SeriousJul/pi-extensions/edit/main/docs/" +
            page.filePath,
      text: "Edit this page",
    },
    socialLinks: [
      { icon: "github", link: "https://github.com/SeriousJul/pi-extensions" },
    ],
    nav: [
      { text: "Extensions", link: "/extensions/codegraph/" },
      { text: "Develop", link: "/develop" },
      { text: "ADR", link: "/adr/" },
      { text: "Glossary", link: "/glossary" },
      { text: "GitHub", link: "https://github.com/SeriousJul/pi-extensions" },
    ],
    sidebar: [
      {
        text: "Extensions",
        items: [
          { text: "codegraph", link: "/extensions/codegraph/" },
          { text: "codegraph internals", link: "/extensions/codegraph/internals" },
          { text: "tools", link: "/extensions/tools" },
          { text: "context-cap", link: "/extensions/context-cap" },
          { text: "initial-context", link: "/extensions/initial-context" },
          { text: "model-router", link: "/extensions/model-router" },
          { text: "llama-refresh", link: "/extensions/llama-refresh" },
          { text: "quota", link: "/extensions/quota" },
          { text: "sync", link: "/extensions/sync/" },
          { text: "sync internals", link: "/extensions/sync/internals" },
          { text: "usage", link: "/extensions/usage" },
          { text: "compress", link: "/extensions/compress" },
          { text: "pruning", link: "/extensions/pruning" },
          { text: "output-limits", link: "/extensions/output-limits" },
          { text: "resource-toggle", link: "/extensions/resource-toggle" },
          { text: "edit-assist", link: "/extensions/edit-assist" },
        ],
      },
      {
        text: "Development",
        items: [
          { text: "Develop", link: "/develop" },
          { text: "ADR", link: "/adr/" },
          { text: "Glossary", link: "/glossary" },
        ],
      },
    ],
  },
});
