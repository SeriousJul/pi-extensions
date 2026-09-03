import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import path from "node:path";
import { buildFixture, type Fixture } from "./fixture";
import codegraphExtension from "../../extensions/codegraph/index";
import {
  CodegraphSession,
  MARKER_NAME,
} from "../../extensions/codegraph/session";
import { CodeGraph, getCodeGraphDir } from "../../extensions/codegraph/codegraph";
import { PROMPT_NOTE } from "../../extensions/codegraph/handlers";
import fs from "node:fs";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

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

function makeExtension() {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  let toolCount = 0;
  const pi = {
    registerTool: () => {
      toolCount += 1;
    },
    registerCommand: () => undefined,
    on: (name: string, fn: (event: unknown, ctx: unknown) => unknown) => {
      handlers.set(name, fn);
    },
  } as unknown as ExtensionAPI;
  codegraphExtension(pi);
  return { handlers, toolCount };
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
    const { handlers, toolCount } = makeExtension();
    expect(toolCount).toBe(6);
    expect(handlers.has("before_agent_start")).toBe(true);
    expect(handlers.has("session_shutdown")).toBe(true);
  });
});

describe("system prompt note", () => {
  it("is not added when the worktree has no index yet", () => {
    const { handlers } = makeExtension();
    const h = handlers.get("before_agent_start")!;
    const result = h(event(), makeCtx(fixture.feature));
    expect(result).toBeUndefined();
  });

  it("is added when the index for the working directory's root is ready", async () => {
    const builder = newSession();
    await builder.ensureReady(fixture.main);

    const { handlers } = makeExtension();
    const h = handlers.get("before_agent_start")!;
    const result = h(event(), makeCtx(fixture.main)) as {
      systemPrompt?: string;
    } | undefined;
    expect(result?.systemPrompt).toContain(PROMPT_NOTE);
    expect(result?.systemPrompt).toContain("codegraph_explore");
  });

  it("is added for a sub-directory of an indexed worktree", async () => {
    const builder = newSession();
    await builder.ensureReady(fixture.feature);

    const { handlers } = makeExtension();
    const h = handlers.get("before_agent_start")!;
    const result = h(
      event(),
      makeCtx(path.join(fixture.feature, "src")),
    ) as { systemPrompt?: string } | undefined;
    expect(result?.systemPrompt).toContain(PROMPT_NOTE);
  });

  it("is not added while another process is building the index", async () => {
    const { handlers } = makeExtension();
    const h = handlers.get("before_agent_start")!;

    // A concurrent session mid-build: the database file exists (created by
    // CodeGraph.init before the build) and a live build marker from another
    // process is present. The note must not steer toward a tool that would
    // block on the build.
    const created = await CodeGraph.init(fixture.feature);
    created.close();
    const { spawn } = await import("node:child_process");
    const peer = spawn("sleep", ["30"], { stdio: "ignore" });
    const markerFile = path.join(
      getCodeGraphDir(fixture.feature),
      MARKER_NAME,
    );
    try {
      fs.writeFileSync(
        markerFile,
        JSON.stringify({ pid: peer.pid, startedAt: Date.now(), mode: "build" }),
      );
      expect(h(event(), makeCtx(fixture.feature))).toBeUndefined();

      // A dead marker is a crashed build, not a live one: the on-disk index
      // is ready again and the note returns.
      peer.kill();
      await new Promise<void>((resolve) => {
        peer.once("exit", () => resolve());
      });
      const result = h(event(), makeCtx(fixture.feature)) as {
        systemPrompt?: string;
      } | undefined;
      expect(result?.systemPrompt).toContain(PROMPT_NOTE);
    } finally {
      if (!peer.killed) peer.kill();
      fs.rmSync(markerFile, { force: true });
    }
  });

  it("is not added for an unindexed worktree of an indexed repository", async () => {
    const builder = newSession();
    await builder.ensureReady(fixture.main);

    // A second, unindexed worktree: the note must not leak from main.
    const { execFileSync } = await import("node:child_process");
    const extra = path.join(fixture.base, "extra");
    execFileSync("git", ["worktree", "add", "-q", "--detach", extra, "HEAD"], {
      cwd: fixture.main,
    });
    try {
      const { handlers } = makeExtension();
      const h = handlers.get("before_agent_start")!;
      const result = h(event(), makeCtx(extra));
      expect(result).toBeUndefined();
    } finally {
      execFileSync("git", ["worktree", "remove", "--force", extra], {
        cwd: fixture.main,
      });
    }
  });
});

describe("environment defaults", () => {
  it("defaults telemetry and update-check vars only when unset", async () => {
    const saved = {
      t: process.env.CODEGRAPH_TELEMETRY,
      u: process.env.CODEGRAPH_NO_UPDATE_CHECK,
    };
    delete process.env.CODEGRAPH_TELEMETRY;
    delete process.env.CODEGRAPH_NO_UPDATE_CHECK;
    try {
      await import("../../extensions/codegraph/env?fresh=" + Date.now());
      expect(process.env.CODEGRAPH_TELEMETRY).toBe("0");
      expect(process.env.CODEGRAPH_NO_UPDATE_CHECK).toBe("1");
    } finally {
      if (saved.t === undefined) delete process.env.CODEGRAPH_TELEMETRY;
      else process.env.CODEGRAPH_TELEMETRY = saved.t;
      if (saved.u === undefined) delete process.env.CODEGRAPH_NO_UPDATE_CHECK;
      else process.env.CODEGRAPH_NO_UPDATE_CHECK = saved.u;
    }
  });

  it("keeps explicit user settings", async () => {
    const saved = {
      t: process.env.CODEGRAPH_TELEMETRY,
      u: process.env.CODEGRAPH_NO_UPDATE_CHECK,
    };
    process.env.CODEGRAPH_TELEMETRY = "1";
    delete process.env.CODEGRAPH_NO_UPDATE_CHECK;
    try {
      await import("../../extensions/codegraph/env?fresh=" + Date.now());
      expect(process.env.CODEGRAPH_TELEMETRY).toBe("1");
      expect(process.env.CODEGRAPH_NO_UPDATE_CHECK).toBe("1");
    } finally {
      if (saved.t === undefined) delete process.env.CODEGRAPH_TELEMETRY;
      else process.env.CODEGRAPH_TELEMETRY = saved.t;
      if (saved.u === undefined) delete process.env.CODEGRAPH_NO_UPDATE_CHECK;
      else process.env.CODEGRAPH_NO_UPDATE_CHECK = saved.u;
    }
  });
});
