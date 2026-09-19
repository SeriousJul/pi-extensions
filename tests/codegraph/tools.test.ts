import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
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
import { createOpenSrc } from "../../extensions/codegraph/opensrc";
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
    onUpdate:
      | ((partial: { content: Array<{ type: string; text: string }> }) => void)
      | undefined,
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

/** A session that trusts the fixture base, with a cache that names the feature worktree. */
function namedSession(): { h: Harness; opensrcHome: string } {
  // A dependency cache that names the feature worktree.
  const opensrcHome = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-preamble-")),
  );
  fs.symlinkSync(
    fixture.feature,
    path.join(opensrcHome, "feature"),
  );
  const s = new CodegraphSession({
    trustedRoots: [
      { root: fixture.base, origin: "CODEGRAPH_PI_TRUSTED_ROOTS" },
    ],
    opensrc: createOpenSrc(opensrcHome, {
      list: () => ({
        repos: [
          { name: "featurelib", version: "9.9.9", path: "feature" },
        ],
      }),
    }),
  });
  sessions.push(s);
  return { h: makeHarness(s, fixture.main), opensrcHome };
}

describe("tool registration", () => {
  it("registers the four codegraph tools, the caller and callee tools left unregistered", () => {
    const { tools } = makeHarness(newSession(), fixture.main);
    // The registered set equals the TOOL map (issue #72): the caller and
    // callee tools are defined in the handlers module but not registered;
    // codegraph_explore carries their information in its call trail.
    expect([...tools.keys()].sort()).toEqual([
      "codegraph_explore",
      "codegraph_impact",
      "codegraph_node",
      "codegraph_search",
    ]);
    expect(tools.has("codegraph_callers")).toBe(false);
    expect(tools.has("codegraph_callees")).toBe(false);
    for (const t of tools.values()) {
      const schema = t.parameters as { properties?: Record<string, unknown> };
      // Spec 0009: every tool can be served from a named project root.
      expect(schema.properties).toHaveProperty("projectRoot");
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

  it("disambiguates a same-named symbol from a sub-directory by its root-relative file", async () => {
    const pkg = path.join(fixture.main, "pkg");
    // The main index carries two definitions of `overloaded`, one per
    // sub-project: pkg/src/x.ts and lib/src/x.ts.
    const ambiguous = await h.call(
      "codegraph_node",
      { symbol: "overloaded" },
      fixture.main,
    );
    expect(ambiguous).toContain("Multiple definitions");

    // From <main>/pkg, `src/x.ts` is a path relative to the working
    // directory. Expressed against the resolved root (pkg/src/x.ts) it
    // selects that definition, not a same-named file elsewhere in the
    // index - the bare form suffix-matches both and reports the ambiguity.
    const text = await h.call(
      "codegraph_node",
      { symbol: "overloaded", file: "src/x.ts" },
      pkg,
    );
    expect(text).toContain("pkg/src/x.ts");
    expect(text).toContain("return x * 3");
    expect(text).not.toContain("Multiple definitions");
    expect(text).not.toContain("return x + 10");

    // A relative form that crosses sub-projects still resolves inside the
    // root, so ../lib/src/x.ts selects lib's definition.
    const across = await h.call(
      "codegraph_node",
      { symbol: "overloaded", file: "../lib/src/x.ts" },
      pkg,
    );
    expect(across).toContain("lib/src/x.ts");
    expect(across).toContain("return x + 10");
    expect(across).not.toContain("Multiple definitions");

    // The disambiguating file moved nothing: the call is still served from
    // the main worktree, and the sub-directory gets no index of its own.
    expect(h.session.statusFor(pkg).root).toBe(fixture.main);
    expect(h.session.statusFor(pkg).needsCreate).toBe(false);
  });

  it("disambiguates a same-named symbol from a sub-directory by its root-relative file in impact", async () => {
    const pkg = path.join(fixture.main, "pkg");
    // Without the root-relative form the bare `src/x.ts` suffix-matches both
    // definitions and reports the ambiguity.
    for (const tool of ["codegraph_impact"]) {
      const ambiguous = await h.call(
        tool,
        { symbol: "overloaded", file: "src/x.ts" },
        fixture.main,
      );
      expect(ambiguous).toContain("Multiple definitions");

      const text = await h.call(
        tool,
        { symbol: "overloaded", file: "src/x.ts" },
        pkg,
      );
      expect(text).toContain("pkg/src/x.ts");
      expect(text).not.toContain("Multiple definitions");
      expect(text).not.toContain("lib/src/x.ts");
    }
  });

  it("keeps a disambiguating file that escapes the root in the caller's own form", async () => {
    // From <main>/pkg, a file that points into the sibling feature worktree
    // escapes the root: the caller's own form is kept, it matches nothing,
    // and no index is created for the other worktree.
    const pkg = path.join(fixture.main, "pkg");
    const rel = path.relative(
      pkg,
      path.join(fixture.feature, "src", "feature.ts"),
    );
    const text = await h.call(
      "codegraph_node",
      { symbol: "featureOnlySymbol", file: rel },
      pkg,
    );
    expect(text).toBe('Symbol "featureOnlySymbol" not found');
    expect(h.session.statusFor(pkg).root).toBe(fixture.main);
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

  it("refuses a file mode anchor outside the session root and writes nothing", async () => {
    // The measured accident behind spec 0008: a file argument pointing at a
    // tree outside the session's own root used to resolve that tree, build
    // an index in it, and serve the file from the wrong project. The call
    // must now fail with the standard unavailable line naming the boundary,
    // and leave no trace on disk anywhere.
    await h.call("codegraph_search", { query: "helper" });

    const outside = path.join(fixture.base, "outside-proj");
    fs.mkdirSync(path.join(outside, "src"), { recursive: true });
    fs.writeFileSync(path.join(outside, "package.json"), "{}");
    const target = path.join(outside, "src", "lib.ts");
    fs.writeFileSync(target, "export const outsideSymbol = 1;\n");

    const ui = freshUi();
    h.session.setUi({
      notify: (level, message) => ui.notifications.push([level, message]),
    });
    const text = await h.call(
      "codegraph_node",
      { file: target },
      fixture.main,
      ui,
    );
    expect(text).toBe(
      `codegraph is unavailable (file ${target} is outside this project (${fixture.main})). Use the built-in read and grep tools instead.`,
    );

    // Nothing is created in the refused tree: no index directory, no
    // ledger, no marker - not even the directory the call refused to
    // index.
    expect(fs.existsSync(path.join(outside, ".codegraph"))).toBe(false);
    expect(fs.existsSync(getCodeGraphDir(outside))).toBe(false);
    expect(fs.readdirSync(outside).sort()).toEqual([
      "package.json",
      "src",
    ]);

    // The refusal is not recorded in the session's own ledger either: a
    // refused call has no index directory to keep a ledger in.
    const sessionLedger = fs
      .readFileSync(
        path.join(getCodeGraphDir(fixture.main), USAGE_NAME),
        "utf-8",
      )
      .trim()
      .split("\n");
    expect(sessionLedger).toHaveLength(1);
    expect(JSON.parse(sessionLedger[0])).toMatchObject({
      tool: "codegraph_search",
      ok: true,
    });

    // One warning per session names the boundary; a second refusal adds
    // none.
    expect(ui.notifications).toEqual([
      [
        "warning",
        `codegraph: file ${target} is outside this project (${fixture.main})`,
      ],
    ]);
    const again = await h.call(
      "codegraph_node",
      { file: target },
      fixture.main,
      ui,
    );
    expect(again).toContain("codegraph is unavailable");
    expect(ui.notifications).toHaveLength(1);
  });

  it("keeps answering codegraph_explore from the session index for an external path in the query", async () => {
    // The other half of the measured accident: explore never anchored on
    // anything but the working directory, so an absolute external path in
    // the query answers from the session's own index - and now that no tool
    // can cross, that is the only answer any path can get.
    await h.call("codegraph_search", { query: "helper" });

    const outside = path.join(fixture.base, "outside-proj");
    fs.mkdirSync(path.join(outside, "src"), { recursive: true });
    fs.writeFileSync(path.join(outside, "package.json"), "{}");
    const target = path.join(outside, "src", "lib.ts");
    fs.writeFileSync(target, "export const outsideSymbol = 1;\n");

    const text = await h.call("codegraph_explore", { query: target });
    expect(text).toBe(`No relevant context found for "${target}"`);
    expect(fs.existsSync(path.join(outside, ".codegraph"))).toBe(false);
    // The call was served by, and recorded in, the session's own index.
    expect(fs.existsSync(getCodeGraphDir(fixture.main))).toBe(true);
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
  });

  it("status shows the block once: the notification, not a widget", async () => {
    // The status block used to render twice - a persistent widget above the
    // input and an info notification in the transcript. The notification is
    // the single surface, so status must never set the codegraph widget.
    const h = makeHarness(newSession(), fixture.main);
    await h.session.ensureReady(fixture.main);
    const ui = freshUi();
    await h.commands.get("codegraph")!.handler("", makeCtx(fixture.main, ui));
    expect(ui.widgets).toHaveLength(0);
    const statusNotes = ui.notifications.filter(([, m]) =>
      m.includes("index:"),
    );
    expect(statusNotes).toHaveLength(1);
  });

  it("status reports usage counts and the last failure", async () => {
    const h = makeHarness(newSession(), fixture.main);
    await h.call("codegraph_search", { query: "helper" });
    const ui = freshUi();
    await h.commands.get("codegraph")!.handler("", makeCtx(fixture.main, ui));
    const joined = ui.notifications.map(([, m]) => m).join("\n");
    expect(joined).toContain("usage: 1 ok, 0 failed (last call");
    expect(joined).toContain("explore: 0  node: 0  search: 1  impact: 0");
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

    // The four keep their settled order and the extra name follows them.
    expect(joined).toContain(
      "explore: 0  node: 0  search: 1  impact: 0  dropped_away: 1",
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
    expect(joined).toContain("explore: 1  node: 0  search: 1  impact: 0");
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
    // The index-mutating verb clears the codegraph widget, so no stale
    // widget survives a rebuild or an uninit.
    expect(acceptUi.widgets).toContainEqual(["codegraph", undefined]);
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

describe("the project preamble (spec 0009)", () => {
  it("prefaces a named result with the label and the absolute root", async () => {
    const { h, opensrcHome } = namedSession();
    const text = await h.call("codegraph_search", {
      query: "featureOnlySymbol",
      projectRoot: fixture.feature,
    });
    const featureReal = fs.realpathSync(fixture.feature);
    expect(text.startsWith(`Project: featurelib @9.9.9 - ${featureReal}\n\n`)).toBe(
      true,
    );
    expect(text).toContain("featureOnlySymbol");
    fs.rmSync(opensrcHome, { recursive: true, force: true });
  });

  it("carries no preamble for a result from the session root", async () => {
    const { h, opensrcHome } = namedSession();
    const text = await h.call("codegraph_search", { query: "mainEntry" });
    expect(text.startsWith("Project:")).toBe(false);
    expect(text).toContain("mainEntry");
    fs.rmSync(opensrcHome, { recursive: true, force: true });
  });
});

describe("the named-root file rule (spec 0009)", () => {
  it("reads a file relative to the named root", async () => {
    const { h, opensrcHome } = namedSession();
    const featureReal = fs.realpathSync(fixture.feature);
    const text = await h.call("codegraph_node", {
      file: "src/feature.ts",
      projectRoot: fixture.feature,
    });
    expect(
      text.startsWith(`Project: featurelib @9.9.9 - ${featureReal}\n\n`),
    ).toBe(true);
    expect(text).toContain("File: src/feature.ts");
    expect(text).toContain("featureOnlySymbol");
    fs.rmSync(opensrcHome, { recursive: true, force: true });
  });

  it("refuses a file that leaves the named root, naming both paths", async () => {
    const { h, opensrcHome } = namedSession();
    const featureReal = fs.realpathSync(fixture.feature);

    // A relative form resolves against the named root and leaves it.
    const escape = path.resolve(featureReal, "..", "main", "src", "shared.ts");
    const rel = await h.call("codegraph_node", {
      file: "../main/src/shared.ts",
      projectRoot: fixture.feature,
    });
    expect(rel).toBe(
      `codegraph is unavailable (file ${escape} is outside the named project root (${featureReal})). Use the built-in read and grep tools instead.`,
    );

    // An absolute form escapes by definition.
    const abs = path.join(fixture.base, "main", "src", "shared.ts");
    const absText = await h.call("codegraph_node", {
      file: abs,
      projectRoot: fixture.feature,
    });
    expect(absText).toBe(
      `codegraph is unavailable (file ${abs} is outside the named project root (${featureReal})). Use the built-in read and grep tools instead.`,
    );

    // A refusal writes nothing: the failed calls created no index directory.
    expect(fs.existsSync(getCodeGraphDir(featureReal))).toBe(false);
    fs.rmSync(opensrcHome, { recursive: true, force: true });
  });

  it("resolves a disambiguating file against the named root, not the working directory", async () => {
    const { h, opensrcHome } = namedSession();
    const featureReal = fs.realpathSync(fixture.feature);
    // `helper` has two definitions in the feature index (src/feature.ts and
    // src/shared.ts), so a disambiguating file must select one.
    const ambiguous = await h.call(
      "codegraph_node",
      { symbol: "helper", projectRoot: fixture.feature },
      fixture.main,
    );
    expect(ambiguous).toContain("Multiple definitions");

    // The working directory sits inside the named root and the file is
    // given in the named root's form: the named-call file rule resolves it
    // inside the named root, so src/feature.ts selects that definition.
    // Resolved against the working directory it would name src/src/feature.ts,
    // a file that does not exist.
    const text = await h.call(
      "codegraph_node",
      {
        symbol: "helper",
        file: "src/feature.ts",
        projectRoot: fixture.feature,
      },
      path.join(featureReal, "src"),
    );
    expect(
      text.startsWith(`Project: featurelib @9.9.9 - ${featureReal}\n\n`),
    ).toBe(true);
    expect(text).toContain("src/feature.ts");
    expect(text).toContain("return x * 2");
    expect(text).not.toContain("Multiple definitions");
    expect(text).not.toContain("return x + ANSWER");

    // A form that leaves the named root keeps the caller's own form and
    // matches nothing: ../../main/src/mainonly.ts resolves into the sibling
    // main worktree, outside the named root. The symbol lives only there
    // (committed on main after the feature branch was cut), so the raw form
    // finds no definition in the named index.
    const escape = await h.call(
      "codegraph_node",
      {
        symbol: "mainOnlySymbol",
        file: "../../main/src/mainonly.ts",
        projectRoot: fixture.feature,
      },
      fixture.main,
    );
    expect(escape).toBe(
      `Project: featurelib @9.9.9 - ${featureReal}\n\nSymbol "mainOnlySymbol" not found`,
    );
    fs.rmSync(opensrcHome, { recursive: true, force: true });
  });
});

describe("build progress stream (issue #72)", () => {
  it("streams at least one progress update on a cold named call and none on a warm one", async () => {
    const { h, opensrcHome } = namedSession();
    const tool = h.tools.get("codegraph_search")!;

    // Cold: the feature tree has no index, so the call builds it inline and
    // the wait must be visible. At least one update reaches the caller
    // before the call completes.
    const cold: string[] = [];
    const coldResult = await tool.execute(
      "1",
      { query: "featureOnlySymbol", projectRoot: fixture.feature },
      undefined,
      (partial) => {
        cold.push(partial.content.map((c) => c.text).join("\n"));
      },
      makeCtx(fixture.main, freshUi()),
    );
    expect(coldResult.content.map((c) => c.text).join("\n")).toContain("featureOnlySymbol");
    expect(cold.length).toBeGreaterThanOrEqual(1);
    expect(cold.some((text) => text.includes("indexing"))).toBe(true);

    // Warm: the index exists, the call reconciles only, and streams nothing.
    const warm: string[] = [];
    const warmResult = await tool.execute(
      "2",
      { query: "featureOnlySymbol", projectRoot: fixture.feature },
      undefined,
      (partial) => {
        warm.push(partial.content.map((c) => c.text).join("\n"));
      },
      makeCtx(fixture.main, freshUi()),
    );
    expect(warmResult.content.map((c) => c.text).join("\n")).toContain("featureOnlySymbol");
    expect(warm).toEqual([]);
    fs.rmSync(opensrcHome, { recursive: true, force: true });
  });
});

describe("/codegraph named-root surface (spec 0009)", () => {
  /** A session whose trusted roots include the whole fixture base. */
  function trustedHarness(): Harness {
    return makeHarness(
      newSession({
        trustedRoots: [
          { root: fixture.base, origin: "CODEGRAPH_PI_TRUSTED_ROOTS" },
        ],
      }),
      fixture.main,
    );
  }

  it("add trusts an existing directory and reports a missing one", async () => {
    const h = trustedHarness();
    const ui = freshUi();
    await h.commands.get("codegraph")!.handler(
      `add ${fixture.main}`,
      makeCtx(fixture.main, ui),
    );
    expect(
      ui.notifications.some(([, m]) => m.includes("trusted root added")),
    ).toBe(true);

    const ui2 = freshUi();
    await h.commands.get("codegraph")!.handler(
      "add no/such/dir",
      makeCtx(fixture.main, ui2),
    );
    expect(
      ui2.notifications.some(([, m]) => m.includes("no such directory")),
    ).toBe(true);
  });


  it("a bare command lists the opened and the trusted named roots", async () => {
    const h = trustedHarness();
    await h.call("codegraph_search", {
      query: "featureOnlySymbol",
      projectRoot: fixture.feature,
    });

    const ui = freshUi();
    await h.commands.get("codegraph")!.handler(
      "",
      makeCtx(fixture.main, ui),
    );
    const text = ui.notifications.map(([, m]) => m).join("\n");
    expect(text).toContain("named roots opened this session");
    expect(text).toContain(`elsewhere/feature - ${fs.realpathSync(fixture.feature)} - `);
    // The line names label, root, state, and the last call (spec 0009).
    expect(text).toContain("- last call ");
    expect(text).toContain("trusted roots");
    expect(text).toContain(`${fixture.base} (CODEGRAPH_PI_TRUSTED_ROOTS)`);
  });

  it("status takes a path and reports that named root", async () => {
    const h = trustedHarness();
    // Open the named root once: its index exists when status reads it.
    await h.call("codegraph_search", {
      query: "featureOnlySymbol",
      projectRoot: fixture.feature,
    });

    const ui = freshUi();
    await h.commands.get("codegraph")!.handler(
      `status ${fixture.feature}`,
      makeCtx(fixture.main, ui),
    );
    const text = ui.notifications.map(([, m]) => m).join("\n");
    expect(text).toContain("codegraph: " + fs.realpathSync(fixture.feature));
    expect(text).toMatch(/index: \d+ files, \d+ nodes, \d+ edges/);

    // A missing directory reports the reason, like every other verb.
    const ui2 = freshUi();
    await h.commands.get("codegraph")!.handler(
      "status no/such/dir",
      makeCtx(fixture.main, ui2),
    );
    expect(
      ui2.notifications.map(([, m]) => m).join("\n"),
    ).toContain("no such directory");
  });

  it("init and uninit take a path argument", async () => {
    const h = trustedHarness();
    const ui = freshUi();
    await h.commands.get("codegraph")!.handler(
      `init ${fixture.feature}`,
      makeCtx(fixture.main, ui),
    );
    await vi.waitFor(
      () =>
        expect(
          ui.notifications.some(([, m]) => m.includes("index rebuilt")),
        ).toBe(true),
      { timeout: 120_000 },
    );

    const ui2 = freshUi();
    await h.commands.get("codegraph")!.handler(
      `uninit ${fixture.feature}`,
      makeCtx(fixture.main, ui2),
    );
    expect(
      ui2.notifications.some(([, m]) => m.includes("removed index")),
    ).toBe(true);
  });

  it("seed takes a named target and seeds it from the session's sibling", async () => {
    const h = trustedHarness();
    // The session root needs an index: it is the seed source.
    await h.call("codegraph_search", { query: "mainEntry" });

    const ui = freshUi();
    await h.commands.get("codegraph")!.handler(
      `seed ${fixture.feature}`,
      makeCtx(fixture.main, ui),
    );
    await vi.waitFor(
      () =>
        expect(
          ui.notifications.some(([, m]) => m.includes("seeded from")),
        ).toBe(true),
      { timeout: 120_000 },
    );
  });
});
