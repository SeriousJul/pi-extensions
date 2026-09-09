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
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
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
let toolCalls = 0;

extension({
  registerTool: (t) => tools.set(t.name, t),
  registerCommand: (name, def) => commands.set(name, def),
  on: (name, fn) => handlers.set(name, fn),
  getActiveTools: () => [...tools.keys()],
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
  toolCalls += 1;
  const res = await tool.execute("1", params, undefined, undefined, ctx);
  return res.content.map((c) => c.text).join("\n");
}

let failed = false;

/** The /codegraph status text for the fixture worktree, read from the command. */
async function statusText() {
  const mark = notifications.length;
  await commands.get("codegraph").handler("", ctx);
  return notifications.slice(mark).map(([, m]) => m).join("\n");
}

/**
 * Poll until the index on disk is complete: its state is `complete` and it
 * carries the fixture's files and symbols. Readiness is proven from the outside
 * (the command's own text), so the check fails when the prewarm never built the
 * index, not only when a tool call is slow.
 */
async function waitForReadyIndex() {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const text = await statusText();
    const counts = /index: (\d+) files, (\d+) nodes, (\d+) edges/.exec(text);
    const state = /index state: (\w+)/.exec(text);
    if (
      state?.[1] === "complete" &&
      counts &&
      Number(counts[1]) >= 3 &&
      Number(counts[2]) > 0
    ) {
      return text;
    }
    if (Date.now() > deadline) {
      throw new Error(`the prewarm never produced a ready index:\n${text}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

try {
  if (tools.size !== 6) throw new Error(`expected 6 tools, got ${tools.size}`);
  if (!commands.has("codegraph")) {
    throw new Error("no /codegraph command registered");
  }

  // The first prompt carries the note and starts the background build. The
  // index must become complete with no tool executed, and the first real call
  // must then be served from that prewarmed index.
  const before = handlers.get("before_agent_start");
  const promptResult = before?.(
    { type: "before_agent_start", prompt: "hello", systemPrompt: "system" },
    ctx,
  );
  if (!promptResult?.systemPrompt?.includes("codegraph index is building now")) {
    throw new Error(`first prompt did not carry the building-state note: ${JSON.stringify(promptResult)}`);
  }
  if (toolCalls !== 0) throw new Error("prewarm made a tool call");
  await waitForReadyIndex();
  if (toolCalls !== 0) {
    throw new Error("the index only became ready because a tool call built it");
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

  // The /codegraph command must report the index counts and the recorded usage
  // of the calls above (the ledger is written by the tool wrapper, in this
  // worktree's index directory).
  const status = await statusText();
  if (!/index: \d+ files, \d+ nodes, \d+ edges/.test(status)) {
    throw new Error(`status did not report the index counts:\n${status}`);
  }
  if (!status.includes("usage: 2 ok, 0 failed")) {
    throw new Error(`status did not report the usage block:\n${status}`);
  }
  if (!status.includes("explore: 0  node: 1  search: 1  impact: 0  callers: 0  callees: 0")) {
    throw new Error(`status did not report the per-tool usage:\n${status}`);
  }

  // /codegraph uninit removes the index and the usage ledger with it: the
  // ledger is disposable with the index.
  const indexDir = path.join(fixture.main, ".codegraph");
  if (!fs.existsSync(path.join(indexDir, "usage.jsonl"))) {
    throw new Error(`no usage ledger was written in ${indexDir}`);
  }
  const uninitMark = notifications.length;
  await commands.get("codegraph").handler("uninit", ctx);
  const uninitText = notifications
    .slice(uninitMark)
    .map(([, m]) => m)
    .join("\n");
  if (!uninitText.includes("removed index")) {
    throw new Error(`uninit did not remove the index:\n${uninitText}`);
  }
  if (fs.existsSync(indexDir)) {
    throw new Error("uninit left the index directory (and its usage ledger) behind");
  }

  // A ledger with no index must stay out of git. With auto-index off the next
  // call can never build one, so its index directory holds only the ledger -
  // and `git add -A` in the user's worktree must not put that file in a commit.
  await commands.get("codegraph").handler("auto off", ctx);
  const refused = await callTool("codegraph_search", { query: "helper" });
  if (!refused.includes("codegraph is unavailable")) {
    throw new Error(`auto off did not fail the call:\n${refused}`);
  }
  if (!fs.existsSync(path.join(indexDir, "usage.jsonl"))) {
    throw new Error(`the failing call left no ledger in ${indexDir}`);
  }
  execFileSync("git", ["add", "-A"], { cwd: fixture.main });
  const staged = execFileSync("git", ["diff", "--cached", "--name-only"], {
    cwd: fixture.main,
    encoding: "utf-8",
  })
    .split("\n")
    .filter((f) => f.endsWith("usage.jsonl"));
  execFileSync("git", ["reset", "-q"], { cwd: fixture.main });
  if (staged.length > 0) {
    throw new Error(`git staged the usage log: ${staged.join(", ")}`);
  }

  console.log(
    "SMOKE OK: codegraph extension loads, prewarms the first turn, and answers under plain node (pi jiti load path)",
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
