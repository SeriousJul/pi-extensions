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
  IN_MEMORY_DIR_NAME,
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

  it("does not serve a failed build left on disk", async () => {
    const r = storeRoot();
    let release!: () => void;
    r.buildGate = new Promise<void>((res) => {
      release = res;
    });
    r.buildOutcome = { success: false, error: "kaboom" };
    const s = newSession();
    const notices: string[] = [];
    s.setUi({ notify: (_level, msg) => notices.push(msg) });
    s.prewarmFor(rootDir);
    await waitFor("the prewarm build to start", () => r.buildCount === 1);

    const call = s.ensureReady(rootDir);
    await settle(20);
    expect(r.buildCount).toBe(1);
    release();

    await expect(call).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof Error && err.message === "index build failed: kaboom",
    );
    // The failed database was discarded, so the waiting call owned a fresh
    // retry instead of opening the incomplete index as if it were ready.
    expect(r.buildCount).toBe(2);
    expect(r.dbExists).toBe(false);
    expect(notices.filter((m) => m.includes("index build failed"))).toHaveLength(1);
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

/**
 * A runtime that fails its preflight cannot serve a codegraph call at all:
 * every public entry asserts the stack before it opens or builds anything. The
 * note and the prewarm promise exactly what such a call delivers, so both step
 * aside on this machine - in every index state, including a ready index on disk.
 */
describe("prewarm and note under a broken runtime", () => {
  const BROKEN: InMemoryFactoryOptions["preflightResult"] = {
    ok: false,
    reason: "the sqlite backend is unavailable",
  };

  function brokenFactory(): IndexAdapterFactory {
    return createInMemoryIndexFactory({ store, preflightResult: BROKEN });
  }

  it("adds no note and starts no build on a fresh worktree", async () => {
    const e = makeEntrypoint(brokenFactory());
    expect(e.agentTurn()).toBeUndefined();
    await settle();
    expect(storeRoot().buildCount).toBe(0);
    expect(storeRoot().createCount).toBe(0);
  });

  it("adds no note over a ready index, where a call would fail all the same", async () => {
    const r = storeRoot();
    r.dirExists = true;
    r.dbExists = true;
    r.indexState = "complete";
    r.addFile("src/alpha.ts", { exports: ["alphaThing"] });

    const healthy = makeEntrypoint(createInMemoryIndexFactory({ store }));
    expect(healthy.agentTurn()?.systemPrompt).toContain(
      "This project has a codegraph index.",
    );

    const broken = makeEntrypoint(brokenFactory());
    expect(broken.agentTurn()).toBeUndefined();
  });

  it("decides the note without warning, leaving the notice to the call", async () => {
    // The runtime notice is actionable and belongs to the path a user is on: a
    // prompt hook that warned would fire on every turn of every project.
    const e = makeEntrypoint(brokenFactory());
    e.agentTurn();
    e.agentTurn();
    await settle();
    expect(noticesOf(e.ui, "preflight")).toHaveLength(0);
    expect(e.ui.notifications).toHaveLength(0);

    const text = await e.callTool("codegraph_search", { query: "alpha" });
    expect(text).toContain("unavailable");
    expect(noticesOf(e.ui, "preflight")).toHaveLength(1);
  });

  it("keeps a per-root prewarm attempt from being spent on a broken stack", async () => {
    // The prewarm used to try the ready seam per root and swallow the failure.
    // One attempt per root would still warn once per root; the gate costs none.
    const s = newSession({ preflightResult: BROKEN });
    const notices: string[] = [];
    s.setUi({ notify: (_level, msg) => notices.push(msg) });
    s.prewarmFor(rootDir);
    await settle();
    expect(storeRoot().createCount).toBe(0);
    expect(notices).toHaveLength(0);
  });
});

/**
 * The turn's cost. The note decision and the prewarm need the same answer, so
 * the hook resolves the project root once and hands that resolution to both.
 * Each root resolution runs exactly one nearest-index lookup (`resolveRoot`
 * calls `findNearestRoot` once), so that count is the resolution count.
 */
describe("one project root resolution per turn", () => {
  /** Wrap a factory to count the nearest-root lookups it is asked for. */
  function countingFactory(base: IndexAdapterFactory): {
    factory: IndexAdapterFactory;
    lookups: () => number;
  } {
    let n = 0;
    const factory = {
      ...base,
      findNearestRoot(startPath: string): string | null {
        n += 1;
        return base.findNearestRoot(startPath);
      },
    };
    return { factory, lookups: () => n };
  }

  it("runs one lookup for the note and the prewarm together", async () => {
    const { factory, lookups } = countingFactory(
      createInMemoryIndexFactory({ store }),
    );
    const e = makeEntrypoint(factory);

    e.agentTurn();
    // Calibration: a turn that resolved the root twice would read 2 here, and a
    // turn that resolved it not at all would add no note and no prewarm.
    expect(lookups()).toBe(1);

    // The background build runs on the turn's resolution, not a fresh walk.
    await waitFor("the prewarm build to start", () => storeRoot().buildCount === 1);
    await waitFor("the prewarmed index to be open", () => storeRoot().open);
    expect(lookups()).toBe(1);

    // Each further turn pays exactly one more, never two.
    e.agentTurn();
    expect(lookups()).toBe(2);
  });
});

/**
 * A command that removes or rebuilds an index must not fight this session's own
 * background build. The build marker guards other processes only, so the guard
 * has to know about the prewarm the session started itself.
 */
describe("a command against a live prewarm", () => {
  /** Park the prewarm inside the create, and report when it is there. */
  async function parkedPrewarm(): Promise<{
    e: Entrypoint;
    r: InMemoryRoot;
    release: () => void;
  }> {
    const r = storeRoot();
    let release!: () => void;
    r.createGate = new Promise<void>((res) => {
      release = res;
    });
    const e = makeEntrypoint(createInMemoryIndexFactory({ store }));
    e.agentTurn();
    await waitFor("the prewarm to reach the create", () => r.createCount === 1);
    return { e, r, release };
  }

  it("refuses uninit rather than deleting a directory the build writes into", async () => {
    const { e, r, release } = await parkedPrewarm();
    // A usage-only index directory on disk: exactly what an unguarded uninit
    // would remove while the background build still owns the root.
    const indexDir = path.join(rootDir, IN_MEMORY_DIR_NAME);
    fs.mkdirSync(indexDir, { recursive: true });
    fs.writeFileSync(path.join(indexDir, "usage.jsonl"), "{}\n", "utf-8");

    await e.command("uninit");
    expect(
      noticesOf(e.ui, "background build is creating the first index"),
    ).toHaveLength(1);
    // The directory the guard refused to delete is still there for the build...
    expect(fs.existsSync(indexDir)).toBe(true);
    expect(r.createCount).toBe(1);

    release();
    await waitFor("the parked prewarm to finish", () => storeRoot().open);
    // ...and the build still owns it afterwards: no verb deleted anything.
    expect(fs.existsSync(indexDir)).toBe(true);
    expect(r.buildCount).toBe(1);
  });

  it("refuses init and seed instead of queueing a second build of the root", async () => {
    const { e, r, release } = await parkedPrewarm();

    await e.command("init");
    await e.command("seed");
    expect(noticesOf(e.ui, "background build is creating the first index")).toHaveLength(
      2,
    );
    expect(r.createCount).toBe(1);
    expect(r.buildCount).toBe(0);

    release();
    await waitFor("the parked prewarm to finish", () => storeRoot().open);
    expect(r.buildCount).toBe(1);
  });

  it("lets the verbs through once the prewarm is done", async () => {
    const e = makeEntrypoint(createInMemoryIndexFactory({ store }));
    e.agentTurn();
    await waitFor("the prewarmed index to be open", () => storeRoot().open);

    await e.command("uninit");
    expect(noticesOf(e.ui, "background build is creating the first index")).toHaveLength(
      0,
    );
    expect(noticesOf(e.ui, "removed")).toHaveLength(1);
  });
});
