#!/usr/bin/env node
/**
 * Plain-Node smoke test for the codegraph extension.
 *
 * pi loads extensions through jiti: on Node in npm install mode and inside
 * its Bun binary. The vitest suite masks a class of breakage that plain
 * Node exposes: codegraph's npm entry is a CJS re-export, and Node ESM
 * cannot detect its named exports (a direct
 * `import { CodeGraph } from "@colbymchenry/codegraph"` throws under Node).
 * This script reproduces pi's Node load path - jiti imports the TypeScript
 * entry point exactly like pi does, a mock ExtensionAPI collects the tools,
 * and a real tool handler runs against a real fixture repository with a
 * real index build.
 *
 * Run: node tests/codegraph/smoke/smoke-node.mjs
 * (also spawned by tests/codegraph/smoke.test.ts in the vitest suite)
 */
import { createJiti } from "jiti/static";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");

// The same loader and import shape pi uses for extensions
// (dist/core/extensions/loader.js: createJiti + jiti.import(default: true)).
const jiti = createJiti(import.meta.url, { moduleCache: false });

const { buildFixture } = await jiti.import(
  path.join(here, "..", "fixture.ts"),
);
const extension = await jiti.import(
  path.join(repoRoot, "extensions", "codegraph", "index.ts"),
  { default: true },
);

if (typeof extension !== "function") {
  console.error(
    "SMOKE FAILED: the extension entry did not export a factory function",
  );
  process.exit(1);
}

const tools = new Map();
const commands = new Map();
const handlers = new Map();
const notifications = [];

extension({
  registerTool: (t) => tools.set(t.name, t),
  registerCommand: (name, def) => commands.set(name, def),
  on: (name, fn) => handlers.set(name, fn),
});

const fixture = buildFixture();
const ctx = {
  cwd: fixture.main,
  ui: {
    notify: (message, type) => notifications.push([type, message]),
    confirm: async () => true,
    setWidget: () => undefined,
    setStatus: () => undefined,
  },
};

async function callTool(name, params) {
  const tool = tools.get(name);
  if (!tool) throw new Error(`no such tool: ${name}`);
  const res = await tool.execute("1", params, undefined, undefined, ctx);
  return res.content.map((c) => c.text).join("\n");
}

let failed = false;
try {
  if (tools.size !== 6) throw new Error(`expected 6 tools, got ${tools.size}`);
  if (!commands.has("codegraph")) {
    throw new Error("no /codegraph command registered");
  }

  // A real index build in the main worktree, then a search served from it.
  const search = await callTool("codegraph_search", { query: "helper" });
  if (
    !search.includes("helper") ||
    !search.includes("src/shared.ts") ||
    search.includes("unavailable")
  ) {
    throw new Error(`codegraph_search did not answer from the index:\n${search}`);
  }

  // File mode of codegraph_node, with the file argument anchoring the root.
  const node = await callTool("codegraph_node", { file: "src/shared.ts" });
  if (!node.includes("File: src/shared.ts")) {
    throw new Error(`codegraph_node did not serve the file:\n${node}`);
  }

  // The /codegraph command must report the index counts for the worktree.
  const before = notifications.length;
  await commands.get("codegraph").handler("", ctx);
  const statusText = notifications
    .slice(before)
    .map(([, m]) => m)
    .join("\n");
  if (!/index: \d+ files, \d+ nodes, \d+ edges/.test(statusText)) {
    throw new Error(`status did not report the index counts:\n${statusText}`);
  }

  console.log(
    "SMOKE OK: codegraph extension loads and answers under plain node (pi jiti load path)",
  );
} catch (err) {
  console.error(
    "SMOKE FAILED:",
    err instanceof Error ? err.message : err,
  );
  failed = true;
} finally {
  // Close the session the way pi would at shutdown, then clean the fixture.
  try {
    handlers.get("session_shutdown")?.();
  } catch {
    // a closing failure must not mask the real result
  }
  fixture.cleanup();
}
process.exit(failed ? 1 : 0);
