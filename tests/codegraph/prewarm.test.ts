/**
 * The first-turn prewarm (spec 0007), pinned at the entrypoint seam and the
 * session seam on the in-memory Index adapter.
 *
 * The prewarm is what breaks the cold-start loop, so these tests pin the
 * mechanism and not just the shape: one agent-start event starts one background
 * build with no tool executed, the first tool call is served from that same
 * build (never a second one), a background failure never reaches a tool result
 * in either window (before the index exists, or during the build), one failed
 * prewarm costs exactly one warning, and a session that shuts down while a
 * prewarm runs adopts nothing from it.
 *
 * The factory reaches the entrypoint through its test seam, so a build is
 * observable (buildCount, createCount) and steerable (gate, outcome) in
 * milliseconds, with no native library and no git.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import codegraphExtension from "../../extensions/codegraph/index";
import { CodegraphSession } from "../../extensions/codegraph/session";
import type { IndexAdapterFactory } from "../../extensions/codegraph/indexAdapter";
import {
  InMemoryIndex,
  createInMemoryIndexFactory,
  type InMemoryFactoryOptions,
  type InMemoryRoot,
} from "./inMemoryIndex";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

interface MockUi {
  notifications: Array<[string, string]>;
}

function freshUi(): MockUi {
  return { notifications: [] };
}

function makeCtx(cwd: string, ui: MockUi): ExtensionContext {
  return {
    cwd,
    ui: {
      notify: (message: string, type: string) => {
        ui.notifications.push([type, message]);
      },
      confirm: async () => true,
      setWidget: () => undefined,
      setStatus: () => undefined,
    },
  } as unknown as ExtensionContext;
}

interface RegisteredTool {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: ExtensionContext,
  ) => Promise<{ content: Array<{ type: string; text: string }> }>;
}

interface RegisteredCommand {
  handler: (args: string, ctx: ExtensionContext) => Promise<void>;
}

interface Entrypoint {
  handlers: Map<string, (event: unknown, ctx: unknown) => unknown>;
  tools: Map<string, RegisteredTool>;
  commands: Map<string, RegisteredCommand>;
  ui: MockUi;
  /** The tool calls the tests executed. A prewarm must never add to it. */
  executed: string[];
  callTool: (name: string, params: Record<string, unknown>) => Promise<string>;
  command: (args: string) => Promise<void>;
  /** Fire one agent turn; returns what the entrypoint did to the prompt. */
  agentTurn: (cwd?: string) => { systemPrompt?: string } | undefined;
}

/**
 * Load the real entrypoint on a mock pi over the in-memory factory.
 * `setActiveTools` mirrors what pi reports as the session's active tools.
 */
function makeEntrypoint(
  factory: IndexAdapterFactory,
  activeTools: string[] = ["codegraph_search"],
): Entrypoint {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const tools = new Map<string, RegisteredTool>();
  const commands = new Map<string, RegisteredCommand>();
  const executed: string[] = [];
  const ui = freshUi();
  let active = activeTools;
  let ctx = makeCtx(rootDir, ui);
  const pi = {
    registerTool: (t: RegisteredTool) => {
      tools.set(t.name, t);
    },
    registerCommand: (name: string, def: RegisteredCommand) => {
      commands.set(name, def);
    },
    on: (name: string, fn: (event: unknown, ctx: unknown) => unknown) => {
      handlers.set(name, fn);
    },
    getActiveTools: () => active,
  } as unknown as ExtensionAPI;
  codegraphExtension(pi, { factory });
  return {
    handlers,
    tools,
    commands,
    executed,
    ui,
    callTool: async (name, params) => {
      const tool = tools.get(name);
      if (!tool) throw new Error(`no such tool: ${name}`);
      executed.push(name);
      const res = await tool.execute("1", params, undefined, undefined, ctx);
      return res.content.map((c) => c.text).join("\n");
    },
    command: (args) => commands.get("codegraph")!.handler(args, ctx),
    agentTurn: (cwd) => {
      ctx = makeCtx(cwd ?? rootDir, ui);
      const h = handlers.get("before_agent_start")!;
      return h(
        { type: "before_agent_start", prompt: "hello", systemPrompt: "system" },
        ctx,
      ) as { systemPrompt?: string } | undefined;
    },
  };
}

/** Let pending background work run, without asserting on it. */
function settle(ms = 50): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

let rootDir: string;
let store: InMemoryIndex;
const sessions: CodegraphSession[] = [];

function newSession(opts: InMemoryFactoryOptions = {}): CodegraphSession {
  const s = new CodegraphSession({
    factory: createInMemoryIndexFactory({ store, ...opts }),
  });
  sessions.push(s);
  return s;
}

function storeRoot(): InMemoryRoot {
  return store.root(rootDir);
}

/** Poll a condition the background prewarm drives: no internal seams needed. */
async function waitFor(what: string, predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await settle(5);
  }
}

function noticesOf(ui: MockUi, needle: string): string[] {
  return ui.notifications.filter(([, m]) => m.includes(needle)).map(([, m]) => m);
}

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-prewarm-"));
  // A non-git project: a manifest and one indexable file.
  fs.writeFileSync(path.join(rootDir, "package.json"), "{}");
  fs.mkdirSync(path.join(rootDir, "src"));
  fs.writeFileSync(
    path.join(rootDir, "src", "alpha.ts"),
    "export function alphaThing(): number { return 1; }\n",
  );
  store = new InMemoryIndex();
});

afterEach(() => {
  for (const s of sessions.splice(0)) s.closeAll();
  fs.rmSync(rootDir, { recursive: true, force: true });
});

describe("prewarm at the entrypoint seam", () => {
  it("starts one background build on the first agent turn with no tool call", async () => {
    const e = makeEntrypoint(createInMemoryIndexFactory({ store }));
    const note = e.agentTurn();
    expect(note?.systemPrompt).toContain(
      "The codegraph index is building now; your first codegraph call may wait a few seconds.",
    );
    await waitFor("the prewarm build to start", () => storeRoot().buildCount === 1);
    expect(e.executed).toEqual([]);
    await waitFor("the prewarmed index to be open", () => storeRoot().open);
    expect(storeRoot().buildCount).toBe(1);
    expect(storeRoot().indexState).toBe("complete");
  });

  it("serves the first tool call from the prewarmed build, not a second one", async () => {
    const e = makeEntrypoint(createInMemoryIndexFactory({ store }));
    e.agentTurn();
    await waitFor("the prewarm to finish", () => storeRoot().open);
    expect(e.executed).toEqual([]);

    const text = await e.callTool("codegraph_search", { query: "alpha" });
    expect(text).toContain("src/alpha.ts");
    expect(text).not.toContain("unavailable");
    expect(storeRoot().buildCount).toBe(1);
  });

  it("prewarms a root once per session, whatever the number of turns", async () => {
    const e = makeEntrypoint(createInMemoryIndexFactory({ store }));
    e.agentTurn();
    e.agentTurn();
    await waitFor("the prewarm build to start", () => storeRoot().buildCount === 1);
    await waitFor("the prewarm to finish", () => storeRoot().open);
    e.agentTurn();
    await settle();
    expect(storeRoot().buildCount).toBe(1);
  });

  it("never prewarms an existing index", async () => {
    const r = storeRoot();
    r.dirExists = true;
    r.dbExists = true;
    r.indexState = "complete";
    r.addFile("src/alpha.ts", { exports: ["alphaThing"] });

    const e = makeEntrypoint(createInMemoryIndexFactory({ store }));
    const note = e.agentTurn();
    expect(note?.systemPrompt).toContain(
      "This project has a codegraph index. It maps every symbol and call in the current worktree",
    );
    await settle();
    expect(r.buildCount).toBe(0);
    expect(store.roots.size).toBe(1);
  });

  it("does not prewarm when CODEGRAPH_PI_PREWARM is off", async () => {
    const previous = process.env.CODEGRAPH_PI_PREWARM;
    process.env.CODEGRAPH_PI_PREWARM = "0";
    try {
      const e = makeEntrypoint(createInMemoryIndexFactory({ store }));
      const note = e.agentTurn();
      expect(note?.systemPrompt).toContain(
        "The codegraph index is not built yet; your first codegraph call builds it and may wait a while.",
      );
      await settle();
      expect(storeRoot().buildCount).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.CODEGRAPH_PI_PREWARM;
      else process.env.CODEGRAPH_PI_PREWARM = previous;
    }
  });

  it("does not prewarm when auto-index is off", async () => {
    const e = makeEntrypoint(createInMemoryIndexFactory({ store }));
    await e.command("auto off");
    e.agentTurn();
    await settle();
    expect(storeRoot().buildCount).toBe(0);
  });

  it("keeps a failed prewarm out of the first tool result and warns once", async () => {
    const r = storeRoot();
    r.createFails = "disk is full";
    const e = makeEntrypoint(createInMemoryIndexFactory({ store }));
    e.agentTurn();
    await waitFor("the prewarm warning", () =>
      noticesOf(e.ui, "prewarm failed").length > 0,
    );
    expect(noticesOf(e.ui, "prewarm failed")).toHaveLength(1);
    expect(r.buildCount).toBe(0);

    // The background cause is gone: the first call takes its own path and is
    // served normally, with no trace of the background failure.
    r.createFails = undefined;
    const text = await e.callTool("codegraph_search", { query: "alpha" });
    expect(text).toContain("src/alpha.ts");
    expect(text).not.toContain("unavailable");
    expect(r.buildCount).toBe(1);
    expect(noticesOf(e.ui, "prewarm failed")).toHaveLength(1);
  });

  it("keeps a prewarm that fails before the index exists out of the tool result", async () => {
    // The window that matters: the background build is inside `createEmpty`,
    // before any instance exists to be reused. A tool call that arrives there
    // can only be served well by waiting for the prewarm and then taking its
    // own path; sharing the background promise would hand it this rejection.
    const r = storeRoot();
    let release!: () => void;
    r.createGate = new Promise<void>((res) => {
      release = res;
    });
    r.createFails = "disk is full";
    r.createFailuresLeft = 1; // only the prewarm's own attempt fails
    const e = makeEntrypoint(createInMemoryIndexFactory({ store }));
    e.agentTurn();
    await waitFor("the prewarm to park before the index exists", () => r.createCount === 1);

    const call = e.callTool("codegraph_search", { query: "alpha" });
    // Let the call reach the wait. Without it, a second create/build would
    // already be running here.
    await settle(20);
    expect(r.createCount).toBe(1);
    expect(r.buildCount).toBe(0);

    release();
    const text = await call;
    expect(text).toContain("src/alpha.ts");
    expect(text).not.toContain("disk is full");
    expect(text).not.toContain("unavailable");
    expect(r.buildCount).toBe(1);
    expect(noticesOf(e.ui, "prewarm failed")).toHaveLength(1);
    expect(e.executed).toEqual(["codegraph_search"]);
  });
});

describe("prewarm at the session seam", () => {
  it("shares one build between a running prewarm and a concurrent tool call", async () => {
    const r = storeRoot();
    let release!: () => void;
    r.buildGate = new Promise<void>((res) => {
      release = res;
    });
    const s = newSession();
    s.setUi({ notify: () => undefined });
    s.prewarmFor(rootDir);
    await waitFor("the prewarm build to start", () => r.buildCount === 1);

    // The first call arrives while the background build still runs: it must
    // wait for that build instead of starting a second one.
    const call = s.ensureReady(rootDir);
    await settle(20);
    expect(r.buildCount).toBe(1);
    release();

    const info = await call;
    expect(info.root).toBe(rootDir);
    expect(r.buildCount).toBe(1); // the build is never paid twice
    expect(r.open).toBe(true);
    expect(info.cg.getNodesByName("alpha.ts")).toHaveLength(1);
  });

  it("leaves nothing open when a prewarm outlives session shutdown", async () => {
    // Case A: the shutdown lands while the build runs, so the instance is
    // already registered and `closeAll` closes it. The watcher must not start
    // afterwards, and the abandoned result must not be reported.
    // The build itself still runs to the end (it cannot be aborted).
    const r = storeRoot();
    let release!: () => void;
    r.buildGate = new Promise<void>((res) => {
      release = res;
    });
    const s = newSession();
    const notices: string[] = [];
    s.setUi({ notify: (_level, msg) => notices.push(msg) });
    s.prewarmFor(rootDir);
    await waitFor("the prewarm build to start", () => r.buildCount === 1);

    s.closeAll();
    release();
    await waitFor("the abandoned build to finish", () => r.indexState === "complete");
    await settle();
    expect(r.open).toBe(false);
    expect(r.watchOptions).toBeUndefined();
    expect(notices).toEqual([]);
  });

  it("refuses to adopt an index a shutdown overtook before it was registered", async () => {
    // Case B: the shutdown lands while the prewarm is still preparing the empty
    // index, before any instance exists. `register` is the seam that has to say
    // no: an adopted instance here is an open database with no owner, and its
    // watcher would outlive the terminal that started it.
    const r = storeRoot();
    let release!: () => void;
    r.createGate = new Promise<void>((res) => {
      release = res;
    });
    const s = newSession();
    const notices: string[] = [];
    s.setUi({ notify: (_level, msg) => notices.push(msg) });
    s.prewarmFor(rootDir);
    await waitFor("the prewarm to park", () => r.createCount === 1);

    s.closeAll();
    release();
    await settle();
    expect(r.open).toBe(false);
    expect(r.watchOptions).toBeUndefined();
    expect(notices).toEqual([]);
  });

  it("retries after a failed prewarm instead of inheriting its failure", async () => {
    const r = storeRoot();
    r.createFails = "disk is full";
    const s = newSession();
    const notices: string[] = [];
    s.setUi({ notify: (_level, msg) => notices.push(msg) });
    s.prewarmFor(rootDir);
    await waitFor("the prewarm warning", () =>
      notices.some((m) => m.includes("prewarm failed")),
    );

    // The background cause is gone. The call must build the index on its own
    // path: the failure text never reaches it.
    r.createFails = undefined;
    const info = await s.ensureReady(rootDir);
    expect(info.justBuilt).toBe(true);
    expect(r.buildCount).toBe(1);
    expect(info.cg.getNodesByName("alpha.ts")).toHaveLength(1);
    expect(notices.filter((m) => m.includes("prewarm failed"))).toHaveLength(1);
  });

  it("reports a structural prewarm failure once, through the path that owns it", async () => {
    const r = storeRoot();
    r.buildOutcome = { success: false, error: "kaboom" };
    const s = newSession();
    const notices: string[] = [];
    s.setUi({ notify: (_level, msg) => notices.push(msg) });
    s.prewarmFor(rootDir);
    await waitFor("the build warning", () =>
      notices.some((m) => m.includes("index build failed")),
    );
    expect(notices.filter((m) => m.includes("index build failed"))).toHaveLength(1);
    expect(notices.filter((m) => m.includes("prewarm failed"))).toHaveLength(0);
  });

  it("warns once per root and does not retry a failed prewarm in the background", async () => {
    const r = storeRoot();
    r.buildOutcome = { success: false, error: "kaboom" };
    const s = newSession();
    const notices: string[] = [];
    s.setUi({ notify: (_level, msg) => notices.push(msg) });
    s.prewarmFor(rootDir);
    await waitFor("the build warning", () => notices.length > 0);
    s.prewarmFor(rootDir);
    await settle();
    expect(r.buildCount).toBe(1);
    expect(notices).toHaveLength(1);
  });
});
