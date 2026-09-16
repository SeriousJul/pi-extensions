// Copies the repo-root glossary (CONTEXT.md) into the docs root as
// glossary.md before the VitePress build.
//
// CONTEXT.md stays at the repo root as the single source: agents update
// only that file, and the generated copy here is gitignored. The edit
// link to the root file and the last-updated value are set in the site
// config (the function form of editLink.pattern and the
// transformPageData hook both branch on glossary.md), because the
// generated file has no git history of its own.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const docsRoot = dirname(fileURLToPath(import.meta.url));
const source = join(docsRoot, "..", "CONTEXT.md");
const target = join(docsRoot, "glossary.md");

const frontMatter = ["---", "title: Glossary", "---", ""].join("\n");

writeFileSync(target, frontMatter + readFileSync(source, "utf8"));
process.stdout.write("glossary.md: generated from CONTEXT.md\n");
