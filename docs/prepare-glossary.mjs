// Copies the repo-root glossary (CONTEXT.md) into the docs root as
// glossary.md before the VitePress build.
//
// CONTEXT.md stays at the repo root as the single source: agents update
// only that file, and the generated copy here is gitignored. The front
// matter redirects the edit link to the root file, since the generated
// copy never exists in the repository.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const docsRoot = dirname(fileURLToPath(import.meta.url));
const source = join(docsRoot, "..", "CONTEXT.md");
const target = join(docsRoot, "glossary.md");

const frontMatter = [
  "---",
  "title: Glossary",
  "editLink:",
  "  pattern: https://github.com/SeriousJul/pi-extensions/edit/main/CONTEXT.md",
  "  text: Edit the glossary (CONTEXT.md)",
  "---",
  "",
].join("\n");

writeFileSync(target, frontMatter + readFileSync(source, "utf8"));
process.stdout.write("glossary.md: generated from CONTEXT.md\n");
