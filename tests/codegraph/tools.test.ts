import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import path from "node:path";
import { buildFixture, type Fixture } from "./fixture";
import { CodegraphSession } from "../../extensions/codegraph/session";
import {
  registerCommand,
  registerTools,
} from "../../extensions/codegraph/handlers";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

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
    expect(h.session.isReadyFor(fixture.main)).toBe(true);
    expect(
      declineUi.notifications.some(([, m]) => m.includes("removed index")),
    ).toBe(false);

    // Accepted: the index is removed.
    const acceptUi = freshUi(true);
    await h.commands.get("codegraph")!.handler("uninit", makeCtx(fixture.main, acceptUi));
    expect(acceptUi.confirms).toBe(1);
    expect(acceptUi.notifications.some(([, m]) => m.includes("removed index"))).toBe(true);
    expect(h.session.isReadyFor(fixture.main)).toBe(false);
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
