import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { buildFixture, type Fixture } from "./fixture";
import codegraphExtension from "../../extensions/codegraph/index";
import { CodegraphSession } from "../../extensions/codegraph/session";
import { clearMarker, writeMarker } from "../../extensions/codegraph/marker";
import { CodeGraph, getCodeGraphDir } from "../../extensions/codegraph/runtime";
import { CODEGRAPH_TOOL_NAMES, promptNoteFor } from "../../extensions/codegraph/handlers";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

/** The ready-state note: what a worktree with a current index is told. */
const READY_NOTE = promptNoteFor("ready");

interface BeforeAgentStartEvent {
  type: "before_agent_start";
  prompt: string;
  systemPrompt: string;
}

function makeCtx(cwd: string): ExtensionContext {
  return {
    cwd,
    ui: {
      notify: () => undefined,
      setStatus: () => undefined,
      setWidget: () => undefined,
    },
  } as unknown as ExtensionContext;
}

interface RegisteredCommand {
  handler: (args: string, ctx: ExtensionContext) => Promise<void>;
}

function makeExtension(activeTools: string[] = []) {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const tools: string[] = [];
  const commands = new Map<string, RegisteredCommand>();
  const pi = {
    registerTool: (t: { name: string }) => {
      tools.push(t.name);
    },
    registerCommand: (name: string, def: RegisteredCommand) => {
      commands.set(name, def);
    },
    on: (name: string, fn: (event: unknown, ctx: unknown) => unknown) => {
      handlers.set(name, fn);
    },
    getActiveTools: () => activeTools,
  } as unknown as ExtensionAPI;
  codegraphExtension(pi);
  return { handlers, tools, commands };
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

function event(systemPrompt = "You are a coding agent."): BeforeAgentStartEvent {
  return { type: "before_agent_start", prompt: "hello", systemPrompt };
}

describe("extension entrypoint", () => {
  it("registers the tools, the command, and the lifecycle hooks", () => {
    const { handlers, tools, commands } = makeExtension();
    expect(tools).toHaveLength(6);
    // The gate that keeps the note honest reads `CODEGRAPH_TOOL_NAMES`, so the
    // names the extension registers and the names that gate advertises must be
    // the same list. A rename that misses one side silences the note in every
    // worktree, with no other test to notice.
    expect([...tools].sort()).toEqual([...CODEGRAPH_TOOL_NAMES].sort());
    expect(commands.has("codegraph")).toBe(true);
    expect(handlers.has("before_agent_start")).toBe(true);
    expect(handlers.has("session_shutdown")).toBe(true);
  });
});

/** Run one agent turn through the entrypoint and return the prompt it built. */
function turn(
  handlers: Map<string, (event: unknown, ctx: unknown) => unknown>,
  cwd: string,
): string | undefined {
  const h = handlers.get("before_agent_start")!;
  const result = h(event(), makeCtx(cwd)) as
    | { systemPrompt?: string }
    | undefined;
  return result?.systemPrompt;
}

describe("system prompt note", () => {
  it("uses the none-state note when a fresh worktree has no index", () => {
    const previous = process.env.CODEGRAPH_PI_PREWARM;
    process.env.CODEGRAPH_PI_PREWARM = "0";
    try {
      const { handlers } = makeExtension(["codegraph_search"]);
      const h = handlers.get("before_agent_start")!;
      const result = h(event(), makeCtx(fixture.feature)) as {
        systemPrompt?: string;
      } | undefined;
      expect(result?.systemPrompt).toContain(
        "The codegraph index is not built yet; your first codegraph call builds it and may wait a while.",
      );
      expect(result?.systemPrompt).toContain("Use bash grep only for text that is not a symbol");
    } finally {
      if (previous === undefined) delete process.env.CODEGRAPH_PI_PREWARM;
      else process.env.CODEGRAPH_PI_PREWARM = previous;
    }
  });

  it("does not add the note or prewarm when no codegraph tool is active", () => {
    const { handlers } = makeExtension();
    expect(turn(handlers, fixture.feature)).toBeUndefined();
  });

  it("adds no note where no codegraph call can resolve a project root", () => {
    // A plain directory with no git repository and no build manifest above it:
    // every call there fails with "no git repository or build manifest found",
    // and nothing is ever indexed. A note promising that the first call builds
    // the index sends the agent to a tool that cannot answer, then back to grep
    // - the exact behavior this spec exists to remove.
    const plain = fs.mkdtempSync(
      path.join(os.tmpdir(), "codegraph-no-project-"),
    );
    try {
      const { handlers } = makeExtension(["codegraph_search"]);
      expect(turn(handlers, plain)).toBeUndefined();
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });

  it("adds no note when auto-index is off and no index exists to serve", async () => {
    const { handlers, commands } = makeExtension(["codegraph_search"]);
    await commands
      .get("codegraph")!
      .handler("auto off", makeCtx(fixture.feature));
    expect(turn(handlers, fixture.feature)).toBeUndefined();

    // With an index on disk the note belongs again: the tools answer from it,
    // whether or not a new one could be built.
    const builder = newSession();
    await builder.ensureReady(fixture.main);
    expect(turn(handlers, fixture.main)).toContain(READY_NOTE);
  });

  it("is added with the ready-state note when the index is ready", async () => {
    const builder = newSession();
    await builder.ensureReady(fixture.main);

    const { handlers } = makeExtension(["codegraph_search"]);
    const h = handlers.get("before_agent_start")!;
    const result = h(event(), makeCtx(fixture.main)) as {
      systemPrompt?: string;
    } | undefined;
    expect(result?.systemPrompt).toContain(READY_NOTE);
    expect(result?.systemPrompt).toContain("codegraph_explore");
  });

  it.skipIf(Boolean(process.versions.bun))(
    "does not advertise an existing index at an unsafe root",
    async () => {
      const builder = newSession();
      await builder.ensureReady(fixture.main);

      const savedHome = process.env.HOME;
      process.env.HOME = fixture.main;
      try {
        const { handlers } = makeExtension(["codegraph_search"]);
        expect(turn(handlers, fixture.main)).toBeUndefined();
      } finally {
        if (savedHome === undefined) delete process.env.HOME;
        else process.env.HOME = savedHome;
      }
    },
  );

  it("is added for a sub-directory of an indexed worktree", async () => {
    const builder = newSession();
    await builder.ensureReady(fixture.feature);

    const { handlers } = makeExtension(["codegraph_search"]);
    const h = handlers.get("before_agent_start")!;
    const result = h(
      event(),
      makeCtx(path.join(fixture.feature, "src")),
    ) as { systemPrompt?: string } | undefined;
    expect(result?.systemPrompt).toContain(READY_NOTE);
  });

  it("uses the building-state note while another process builds the index", async () => {
    const { handlers } = makeExtension(["codegraph_search"]);
    const h = handlers.get("before_agent_start")!;

    // A concurrent session mid-build: the database file exists (created by
    // CodeGraph.init before the build) and a live build marker from another
    // process is present. The note must not steer toward a tool that would
    // block on the build.
    const created = await CodeGraph.init(fixture.feature);
    created.close();
    const { spawn } = await import("node:child_process");
    const peer = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      writeMarker(getCodeGraphDir(fixture.feature), "build", peer.pid!);
      const building = h(event(), makeCtx(fixture.feature)) as {
        systemPrompt?: string;
      } | undefined;
      expect(building?.systemPrompt).toContain(
        "The codegraph index is building now; your first codegraph call may wait a few seconds.",
      );

      // A dead marker is a crashed build, not a live one: the on-disk index
      // is ready again and the note returns.
      peer.kill();
      await new Promise<void>((resolve) => {
        peer.once("exit", () => resolve());
      });
      const result = h(event(), makeCtx(fixture.feature)) as {
        systemPrompt?: string;
      } | undefined;
      expect(result?.systemPrompt).toContain(READY_NOTE);
    } finally {
      if (!peer.killed) peer.kill();
      clearMarker(getCodeGraphDir(fixture.feature));
    }
  });

  it("uses the none-state note without leaking an index from a sibling", async () => {
    const builder = newSession();
    await builder.ensureReady(fixture.main);

    // A second, unindexed worktree: the note must not leak from main.
    const { execFileSync } = await import("node:child_process");
    const extra = path.join(fixture.base, "extra");
    execFileSync("git", ["worktree", "add", "-q", "--detach", extra, "HEAD"], {
      cwd: fixture.main,
    });
    try {
      const previous = process.env.CODEGRAPH_PI_PREWARM;
      process.env.CODEGRAPH_PI_PREWARM = "0";
      try {
        const { handlers } = makeExtension(["codegraph_search"]);
        const h = handlers.get("before_agent_start")!;
        const result = h(event(), makeCtx(extra)) as {
          systemPrompt?: string;
        } | undefined;
        expect(result?.systemPrompt).toContain(
          "The codegraph index is not built yet; your first codegraph call builds it and may wait a while.",
        );
      } finally {
        if (previous === undefined) delete process.env.CODEGRAPH_PI_PREWARM;
        else process.env.CODEGRAPH_PI_PREWARM = previous;
      }
    } finally {
      execFileSync("git", ["worktree", "remove", "--force", extra], {
        cwd: fixture.main,
      });
    }
  });
});
