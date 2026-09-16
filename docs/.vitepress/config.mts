import { defineConfig } from "vitepress";

export default defineConfig({
  title: "pi-extensions",
  description:
    "A pi package that bundles pi extensions: codegraph, quota, model router, sync, and more.",
  base: "/pi-extensions/",
  // Follow the reader's light/dark preference (built-in themes).
  lastUpdated: true,
  editLink: {
    pattern:
      "https://github.com/SeriousJul/pi-extensions/edit/main/docs/:path",
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
        { text: "quota", link: "/extensions/quota" },
        { text: "sync", link: "/extensions/sync/" },
        { text: "sync internals", link: "/extensions/sync/internals" },
        { text: "usage", link: "/extensions/usage" },
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
});
