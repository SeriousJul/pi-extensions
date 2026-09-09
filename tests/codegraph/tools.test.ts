import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildFixture, type Fixture } from "./fixture";
import { CodegraphSession } from "../../extensions/codegraph/session";
import {
  registerCommand,
  registerTools,
} from "../../extensions/codegraph/handlers";
import { createInMemoryIndexFactory } from "./inMemoryIndex";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getCodeGraphDir, getDatabasePath } from "../../extensions/codegraph/runtime";
import { appendUsage, IGNORE_NAME, USAGE_NAME } from "../../extensions/codegraph/usage";

interface MockUi {
  notifications: Array<[string, string]>;
  statuses: Array<string | undefined>;
  widgets: Array<[string, string[] | undefined]>;
  confirmResponse: boolean;
  confirms: number;
}

function freshUi(confirmResponse = true): MockUi {
  return {
    notifications: [],
    statuses: [],
    widgets: [],
    confirmResponse,
    confirms: 0,
  };
}

function makeCtx(cwd: string, ui: MockUi): ExtensionContext {
  return {
    cwd,
    ui: {
      notify: (message: string, type: string) => {
        ui.notifications.push([type, message]);
      },
      confirm: async () => {
        ui.confirms += 1;
        return ui.confirmResponse;
      },
      setWidget: (key: string, content: string[] | undefined) => {
        ui.widgets.push([key, content]);
      },
      setStatus: (_key: string, text: string | undefined) => {
        ui.statuses.push(text);
      },
    },
  } as unknown as ExtensionContext;
}

interface RegisteredTool {
  name: string;
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: ExtensionContext,
  ) => Promise<{ content: Array<{ type: string; text: string }> }>;
}

interface Harness {
  session: CodegraphSession;
  tools: Map<string, RegisteredTool>;
  commands: Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>;
  call: (
    tool: string,
    params: Record<string, unknown>,
    cwd?: string,
    ui?: MockUi,
  ) => Promise<string>;
}

/** Register the extension's tools and command on a mock pi, wired to one session. */
function makeHarness(
  session: CodegraphSession,
  defaultCwd: string,
): Harness {
  const tools = new Map<string, RegisteredTool>();
  const commands = new Map<
    string,
    { handler: (args: string, ctx: ExtensionContext) => Promise<void> }
  >();
  const pi = {
    registerTool: (t: RegisteredTool) => {
      tools.set(t.name, t);
    },
    registerCommand: (name: string, def: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => {
      commands.set(name, def);
    },
  } as unknown as ExtensionAPI;
  registerTools(pi, session);
  registerCommand(pi, session);
  let ui = freshUi();
  return {
    session,
    tools,
    commands,
    call: async (tool, params, cwd = defaultCwd, uiArg) => {
      ui = uiArg ?? freshUi();
      const t = tools.get(tool);
      if (!t) throw new Error(`no such tool: ${tool}`);
      const res = await t.execute("1", params, undefined, undefined, makeCtx(cwd, ui));
      return res.content.map((c) => c.text).join("\n");
    },
  };
}

let fixture: Fixture;
const sessions: CodegraphSession[] = [];

beforeEach(() => {
  fixture = buildFixture();
});

afterEach(() => {
  for (const s of sessions.splice(0)) s.closeAll();
  fixture.cleanup();
});

function newSession(
  opts: ConstructorParameters<typeof CodegraphSession>[0] = {},
): CodegraphSession {
  const s = new CodegraphSession(opts);
  sessions.push(s);
  return s;
}

describe("tool registration", () => {
  it("registers the six codegraph tools, none with a projectPath parameter", () => {
    const { tools } = makeHarness(newSession(), fixture.main);
    expect([...tools.keys()].sort()).toEqual([
      "codegraph_callees",
      "codegraph_callers",
      "codegraph_explore",
      "codegraph_impact",
      "codegraph_node",
      "codegraph_search",
    ]);
    for (const t of tools.values()) {
      expect(JSON.stringify(t.parameters)).not.toContain("projectPath");
    }
  });
});

describe("tool outputs", () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness(newSession(), fixture.main);
  });

  it("search returns symbol locations without code", async () => {
    const text = await h.call("codegraph_search", { query: "helper" });
    expect(text).toContain("helper");
    expect(text).toContain("src/shared.ts");
    // locations only - no function body
    expect(text).not.toContain("return x + ANSWER");
  });

  it("search accepts the upstream single-string kind and an array of kinds", async () => {
    // Upstream shape: one kind string. `helper` is a function.
    const byString = await h.call("codegraph_search", {
      query: "helper",
      kind: "function",
    });
    expect(byString).toContain("helper");

    // The filter is applied, not ignored: a non-matching kind excludes it.
    const none = await h.call("codegraph_search", {
      query: "helper",
      kind: "class",
    });
    expect(none).toContain('No symbols found matching "helper"');

    // The array superset still works.
    const byArray = await h.call("codegraph_search", {
      query: "helper",
      kind: ["function"],
    });
    expect(byArray).toContain("helper");
  });

  it("node file mode returns line-numbered source with a dependents header", async () => {
    const text = await h.call("codegraph_node", { file: "src/shared.ts" });
    expect(text).toContain("File: src/shared.ts");
    expect(text).toContain("1\t");
    expect(text).toContain("export const ANSWER");
    expect(text).toContain("Depended on by:");
  });

  it("node file mode resolves a sub-directory fragment of the path", async () => {
    const text = await h.call("codegraph_node", { file: "shared" });
    expect(text).toContain("File: src/shared.ts");
  });

  it("node file mode reports an argument that names the project root as absent", async () => {
    // A `file` argument that points at the root itself (".", "", the absolute
    // root, or the nested "./" form) names a directory, never a file. The
    // lookup must not substring-match it against the whole index: the answer
    // is that the file is not in the index.
    for (const arg of [".", "", "./", fixture.main]) {
      expect(await h.call("codegraph_node", { file: arg })).toBe(
        'File "." not found in the index. Use the built-in read tool for files outside the index.',
      );
    }
  });

  it("node symbol mode returns signature, body, and top callers/callees", async () => {
    const text = await h.call("codegraph_node", { symbol: "helper" });
    expect(text).toContain("helper (function)");
    expect(text).toContain("return x + ANSWER");
    expect(text).toContain("Top callers");
    expect(text).toContain("Top callees");
  });

  it("callers lists what calls the symbol", async () => {
    const text = await h.call("codegraph_callers", { symbol: "helper" });
    expect(text).toContain("mainEntry");
  });

  it("callees lists what the symbol calls", async () => {
    const text = await h.call("codegraph_callees", { symbol: "mainEntry" });
    expect(text).toContain("helper");
  });

  it("impact lists dependent code by file", async () => {
    const text = await h.call("codegraph_impact", { symbol: "helper" });
    expect(text).toContain("Impact of helper");
    expect(text).toContain("src/main.ts");
  });

  it("explore returns source and call paths", async () => {
    const text = await h.call("codegraph_explore", { query: "helper mainEntry" });
    expect(text).toContain("## src/shared.ts");
    expect(text).toContain("Call paths:");
    expect(text).toContain("mainEntry");
  });

  it("explore honors maxFiles: caps the file sections and reports the omission", async () => {
    const full = await h.call("codegraph_explore", { query: "helper mainEntry" });
    const fullFiles = full
      .split("\n")
      .filter((l) => l.startsWith("## ")).length;
    expect(fullFiles).toBeGreaterThanOrEqual(2);
    expect(full).not.toContain("omitted");

    const capped = await h.call("codegraph_explore", {
      query: "helper mainEntry",
      maxFiles: 1,
    });
    const cappedFiles = capped
      .split("\n")
      .filter((l) => l.startsWith("## ")).length;
    expect(cappedFiles).toBe(1);
    expect(capped).toContain("more file(s) omitted (maxFiles: 1)");
  });

  it("node with symbol+file runs symbol mode narrowed to the file, not file mode", async () => {
    // In the feature worktree, `helper` has two definitions (src/shared.ts
    // and src/feature.ts). With the old file-first precedence this call
    // returned the whole-file view of feature.ts; symbol mode must win and
    // narrow to the definition in that file.
    const text = await h.call(
      "codegraph_node",
      { symbol: "helper", file: "src/feature.ts" },
      fixture.feature,
    );
    expect(text).toContain("helper (function)");
    expect(text).toContain("src/feature.ts");
    expect(text).toContain("return x * 2");
    expect(text).toContain("Top callers");
    expect(text).not.toContain("File: src/feature.ts");
  });

  it("node with symbol+line narrows to the definition at that line", async () => {
    // In the feature worktree, `helper` is overloaded. Line 3 is inside
    // src/shared.ts's helper (lines 3-5) but not feature.ts's (lines 5-7).
    const text = await h.call(
      "codegraph_node",
      { symbol: "helper", line: 3 },
      fixture.feature,
    );
    expect(text).not.toContain("Multiple definitions");
    expect(text).toContain("src/shared.ts");
    expect(text).toContain("return x + ANSWER");
    expect(text).not.toContain("return x * 2");
  });

  it("does not anchor node symbol mode on its file parameter", async () => {
    const rel = path.relative(
      fixture.main,
      path.join(fixture.feature, "src", "feature.ts"),
    );
    const text = await h.call(
      "codegraph_node",
      { symbol: "featureOnlySymbol", file: rel },
      fixture.main,
    );
    expect(text).toBe('Symbol "featureOnlySymbol" not found');
    expect(h.session.statusFor(fixture.main).root).toBe(fixture.main);
    expect(h.session.statusFor(fixture.feature).needsCreate).toBe(true);
  });

  it("reports an out-of-root file as not found", async () => {
    const baseFactory = createInMemoryIndexFactory();
    const factory = {
      ...baseFactory,
      findNearestRoot(startPath: string): string | null {
        // Model a nearest-root lookup that resolves an existing project while
        // the requested path itself is outside that root. That result is not
        // an ancestor walk a real lookup can produce (both the real factory
        // and the in-memory one walk ancestors); the escape rule is pinned
        // here for its behavior and by a reachable setup (a symlinked
        // worktree path) in session.test.ts.
        if (path.resolve(startPath) === fixture.base) return fixture.main;
        return baseFactory.findNearestRoot(startPath);
      },
    };
    const outsideHarness = makeHarness(newSession({ factory }), fixture.main);

    await outsideHarness.call("codegraph_search", { query: "helper" });
    const outside = path.join(fixture.base, "outside.ts");
    const relative = path.relative(fixture.main, outside);

    // The root-relative form would leave the root, so each argument is
    // looked up as written: never a path outside the project root.
    expect(
      await outsideHarness.call("codegraph_node", { file: outside }),
    ).toBe(
      `File "${outside}" not found in the index. Use the built-in read tool for files outside the index.`,
    );
    expect(
      await outsideHarness.call("codegraph_node", { file: relative }),
    ).toBe(
      `File "${relative}" not found in the index. Use the built-in read tool for files outside the index.`,
    );
  });

  it("serves each worktree from its own index", async () => {
    await h.call("codegraph_search", { query: "helper" }, fixture.main);
    const text = await h.call(
      "codegraph_search",
      { query: "featureOnlySymbol" },
      fixture.feature,
    );
    expect(text).toContain("featureOnlySymbol");
    expect(text).toContain("src/feature.ts");
  });

  it("anchors codegraph_node file mode on the file's own worktree", async () => {
    // From the main worktree, ask for a file that only exists in the
    // feature worktree: the file argument must anchor root resolution to
    // the feature worktree, whose index is then created (seeded) for it.
    await h.call("codegraph_search", { query: "helper" }, fixture.main);
    const rel = path.relative(
      fixture.main,
      path.join(fixture.feature, "src", "feature.ts"),
    );
    const text = await h.call("codegraph_node", { file: rel }, fixture.main);
    expect(text).toContain("File: src/feature.ts");
    expect(text).toContain("featureOnlySymbol");
  });

  it("maps every failure to the standard fallback line", async () => {
    const h2 = makeHarness(newSession({ autoIndex: false }), fixture.main);
    const text = await h2.call("codegraph_search", { query: "helper" });
    expect(text).toBe(
      "codegraph is unavailable (auto-index is off for this session (enable it with /codegraph auto on)). Use the built-in read and grep tools instead.",
    );
  });

  it("writes one usage record for successful and failed calls", async () => {
    const success = await h.call("codegraph_search", { query: "helper" });
    expect(success).toContain("helper");

    const failedHarness = makeHarness(
      newSession({ autoIndex: false }),
      fixture.feature,
    );
    const failure = await failedHarness.call("codegraph_search", {
      query: "helper",
    });
    expect(failure).toContain("codegraph is unavailable");

    const successLines = fs
      .readFileSync(path.join(getCodeGraphDir(fixture.main), USAGE_NAME), "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(successLines).toHaveLength(1);
    expect(successLines[0]).toMatchObject({
      tool: "codegraph_search",
      ok: true,
    });
    expect(successLines[0].duration_ms).toBeGreaterThanOrEqual(0);
    expect(successLines[0].chars).toBeGreaterThan(0);

    const failureLines = fs
      .readFileSync(path.join(getCodeGraphDir(fixture.feature), USAGE_NAME), "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(failureLines).toHaveLength(1);
    expect(failureLines[0]).toMatchObject({
      tool: "codegraph_search",
      ok: false,
      chars: 0,
      reason: "auto-index is off for this session (enable it with /codegraph auto on)",
    });
  });

  it("does not write a ledger when no project root resolves", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-no-project-"));
    try {
      const h = makeHarness(newSession({ autoIndex: false }), outside);
      const text = await h.call("codegraph_search", { query: "helper" });
      expect(text).toContain("no git repository or build manifest found");
      expect(fs.existsSync(getCodeGraphDir(outside))).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("reports unknown symbols without failing", async () => {
    const text = await h.call("codegraph_search", { query: "noSuchSymbolZzz" });
    expect(text).toContain('No symbols found matching "noSuchSymbolZzz"');
    const nodeText = await h.call("codegraph_node", { symbol: "noSuchSymbolZzz" });
    expect(nodeText).toContain("not found");
  });
});

describe("/codegraph command", () => {
  it("status reports the root without creating an index", async () => {
    const h = makeHarness(newSession(), fixture.main);
    const ui = freshUi();
    await h.commands.get("codegraph")!.handler("", makeCtx(fixture.main, ui));
    const joined = ui.notifications.map(([, m]) => m).join("\n");
    expect(joined).toContain("codegraph: " + fixture.main);
    expect(joined).toContain("index: none yet");
    expect(ui.widgets.some(([key]) => key === "codegraph")).toBe(true);
  });

  it("status reports usage counts and the last failure", async () => {
    const h = makeHarness(newSession(), fixture.main);
    await h.call("codegraph_search", { query: "helper" });
    const ui = freshUi();
    await h.commands.get("codegraph")!.handler("", makeCtx(fixture.main, ui));
    const joined = ui.notifications.map(([, m]) => m).join("\n");
    expect(joined).toContain("usage: 1 ok, 0 failed (last call");
    expect(joined).toContain("explore: 0  node: 0  search: 1  impact: 0  callers: 0  callees: 0");
    expect(joined).not.toContain("last failure:");

    const failedHarness = makeHarness(newSession({ autoIndex: false }), fixture.feature);
    await failedHarness.call("codegraph_search", { query: "helper" });
    const failedUi = freshUi();
    await failedHarness.commands
      .get("codegraph")!
      .handler("", makeCtx(fixture.feature, failedUi));
    const failedText = failedUi.notifications.map(([, m]) => m).join("\n");
    expect(failedText).toContain("usage: 0 ok, 1 failed (last call");
    expect(failedText).toContain("last failure: auto-index is off for this session");
  });

  it("shows every recorded call in the per-tool row, not only the six tools", async () => {
    // The row used to print only the tool names this file lists, so a ledger
    // line for any other name counted toward the totals and stayed invisible.
    // A call that is recorded must be a call the display accounts for.
    const h = makeHarness(newSession(), fixture.main);
    await h.call("codegraph_search", { query: "helper" });
    appendUsage(getCodeGraphDir(fixture.main), {
      tool: "codegraph_dropped_away",
      ok: false,
      reason: "no such tool any more",
      duration_ms: 7,
      chars: 0,
    });

    const ui = freshUi();
    await h.commands.get("codegraph")!.handler("", makeCtx(fixture.main, ui));
    const joined = ui.notifications.map(([, m]) => m).join("\n");

    // The six keep their settled order and the extra name follows them.
    expect(joined).toContain(
      "explore: 0  node: 0  search: 1  impact: 0  callers: 0  callees: 0  dropped_away: 1",
    );
    // The totals and the row now account for the same two calls.
    expect(joined).toContain("usage: 1 ok, 1 failed (last call");
    expect(joined).toContain("last failure: no such tool any more");
  });

  it("accumulates usage across sessions of the same worktree", async () => {
    const first = makeHarness(newSession(), fixture.main);
    await first.call("codegraph_search", { query: "helper" });
    first.session.closeAll();

    // A fresh session (a new pi run over the same worktree): the ledger
    // persists, so the counts are the worktree's total, not this session's.
    const second = makeHarness(newSession(), fixture.main);
    await second.call("codegraph_explore", { query: "helper" });
    const ui = freshUi();
    await second.commands.get("codegraph")!.handler("", makeCtx(fixture.main, ui));
    const joined = ui.notifications.map(([, m]) => m).join("\n");
    expect(joined).toContain("usage: 2 ok, 0 failed");
    expect(joined).toContain("explore: 1  node: 0  search: 1  impact: 0  callers: 0  callees: 0");
  });

  it("status reports file/node/edge counts and index state once ready", async () => {
    const h = makeHarness(newSession(), fixture.main);
    await h.session.ensureReady(fixture.main);
    const ui = freshUi();
    await h.commands.get("codegraph")!.handler("", makeCtx(fixture.main, ui));
    const joined = ui.notifications.map(([, m]) => m).join("\n");
    expect(joined).toMatch(/index: \d+ files, \d+ nodes, \d+ edges/);
    expect(joined).toContain("index state:");
  });

  it("status reports the counts when the index is on disk but not open", async () => {
    const builder = newSession();
    await builder.ensureReady(fixture.main);
    const open = builder.statusFor(fixture.main);
    expect(open.instanceOpen).toBe(true);
    expect(open.stats).toBeDefined();
    builder.closeAll();

    // A fresh session has not opened the index: the counts must still be
    // reported, read from the index database.
    const h = makeHarness(newSession(), fixture.main);
    const closed = h.session.statusFor(fixture.main);
    expect(closed.instanceOpen).toBe(false);
    expect(closed.stats?.fileCount).toBe(open.stats?.fileCount);
    expect(closed.stats?.nodeCount).toBe(open.stats?.nodeCount);
    expect(closed.stats?.edgeCount).toBe(open.stats?.edgeCount);
    expect(closed.indexState).toBe(open.indexState);

    const ui = freshUi();
    await h.commands.get("codegraph")!.handler("", makeCtx(fixture.main, ui));
    const joined = ui.notifications.map(([, m]) => m).join("\n");
    expect(joined).toMatch(/index: \d+ files, \d+ nodes, \d+ edges/);
    expect(joined).toContain("index state:");
  });

  it("uninit confirms before deleting anything", async () => {
    const h = makeHarness(newSession(), fixture.main);
    await h.session.ensureReady(fixture.main);

    // Declined: nothing is deleted.
    const declineUi = freshUi(false);
    await h.commands.get("codegraph")!.handler("uninit", makeCtx(fixture.main, declineUi));
    expect(declineUi.confirms).toBe(1);
    expect(declineUi.notifications.some(([, m]) => m.includes("cancelled"))).toBe(true);
    expect(h.session.indexStateFor(fixture.main)).toBe("ready");
    expect(
      declineUi.notifications.some(([, m]) => m.includes("removed index")),
    ).toBe(false);

    // Accepted: the index is removed.
    const acceptUi = freshUi(true);
    await h.commands.get("codegraph")!.handler("uninit", makeCtx(fixture.main, acceptUi));
    expect(acceptUi.confirms).toBe(1);
    expect(acceptUi.notifications.some(([, m]) => m.includes("removed index"))).toBe(true);
    // The index is gone and a build is possible again: the note returns in its
    // "none" state, which is the promise the tools can keep.
    expect(h.session.indexStateFor(fixture.main)).toBe("none");
  });

  it("uninit removes a usage ledger that has no index", async () => {
    // Auto-index off: the call fails, records its reason, and builds nothing.
    // The ledger still lives in the index directory, so uninit must clean it.
    const h = makeHarness(newSession({ autoIndex: false }), fixture.feature);
    const text = await h.call("codegraph_search", { query: "helper" });
    expect(text).toContain("codegraph is unavailable");
    const indexDir = getCodeGraphDir(fixture.feature);
    expect(fs.existsSync(path.join(indexDir, USAGE_NAME))).toBe(true);
    expect(fs.existsSync(getDatabasePath(fixture.feature))).toBe(false);

    const ui = freshUi();
    await h.commands.get("codegraph")!.handler("uninit", makeCtx(fixture.feature, ui));
    expect(
      ui.notifications.some(([, m]) => m.includes("removed the usage log")),
    ).toBe(true);
    expect(fs.existsSync(indexDir)).toBe(false);

    // Status reads the ledger again: there is nothing left to report.
    const statusUi = freshUi();
    await h.commands.get("codegraph")!.handler("", makeCtx(fixture.feature, statusUi));
    expect(statusUi.notifications.map(([, m]) => m).join("\n")).toContain(
      "usage: 0 ok, 0 failed",
    );
  });

  it("never lets git stage the usage ledger", async () => {
    // The ledger of a worktree with no index is the only file in the index
    // directory, and codegraph writes its own ignore file only when it builds an
    // index there. Without one, `git add -A` in the user's worktree commits a
    // local usage log with the rest of the change.
    const h = makeHarness(newSession({ autoIndex: false }), fixture.feature);
    const text = await h.call("codegraph_search", { query: "helper" });
    expect(text).toContain("codegraph is unavailable");
    const indexDir = getCodeGraphDir(fixture.feature);
    const relDir = path.relative(fixture.feature, indexDir).split(path.sep).join("/");
    expect(fs.existsSync(path.join(indexDir, USAGE_NAME))).toBe(true);

    // The ledger itself is ignored, exactly as the index database would be.
    expect(
      spawnSync("git", ["check-ignore", "-q", `${relDir}/${USAGE_NAME}`], {
        cwd: fixture.feature,
      }).status,
    ).toBe(0);

    // And an add-all of the worktree stages no ledger. The ignore file is the
    // only thing git may see there, which is how codegraph treats its own index
    // directory: its default ignore file keeps just that one file visible.
    execFileSync("git", ["add", "-A"], { cwd: fixture.feature });
    try {
      const staged = execFileSync(
        "git",
        ["diff", "--cached", "--name-only"],
        { cwd: fixture.feature, encoding: "utf-8" },
      )
        .split("\n")
        .filter(Boolean);
      expect(staged.filter((f) => f.endsWith(USAGE_NAME))).toEqual([]);
      expect(staged.filter((f) => f.startsWith(`${relDir}/`))).toEqual([
        `${relDir}/${IGNORE_NAME}`,
      ]);
    } finally {
      execFileSync("git", ["reset", "-q"], { cwd: fixture.feature });
    }
  });

  it("auto on/off toggles the automatic index", async () => {
    const h = makeHarness(newSession(), fixture.main);
    const ui = freshUi();
    await h.commands.get("codegraph")!.handler("auto off", makeCtx(fixture.main, ui));
    expect(h.session.autoIndex).toBe(false);
    await h.commands.get("codegraph")!.handler("auto on", makeCtx(fixture.main, ui));
    expect(h.session.autoIndex).toBe(true);
    await h.commands.get("codegraph")!.handler("auto maybe", makeCtx(fixture.main, ui));
    expect(h.session.autoIndex).toBe(true);
    expect(
      ui.notifications.some(([, m]) => m.includes("usage: /codegraph auto")),
    ).toBe(true);
  });

  it("unknown verbs report usage", async () => {
    const h = makeHarness(newSession(), fixture.main);
    const ui = freshUi();
    await h.commands.get("codegraph")!.handler("frobnicate", makeCtx(fixture.main, ui));
    expect(ui.notifications.some(([, m]) => m.includes("unknown verb"))).toBe(true);
  });
});
