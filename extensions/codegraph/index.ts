/**
 * codegraph extension entrypoint.
 *
 * Embeds the codegraph library in-process (no MCP, no daemon): registers the
 * six codegraph tools and the /codegraph command, and keeps one index open
 * per project root in this pi session. Every worktree of a git repository
 * gets its own index, seeded from a sibling worktree's index and kept
 * current by codegraph's own file watcher (with a reconcile before every
 * query when watching is degraded).
 *
 * The library is reached only through the Index adapter (spec 0003): the
 * real factory is injected into the session here. The env defaults that
 * must precede the codegraph library load live in runtime.ts (loaded
 * through the adapter's import of it), ahead of the library load in file
 * order, so no file can load the library without them.
 */
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  CODEGRAPH_TOOL_NAMES,
  promptNoteFor,
  registerCommand,
  registerTools,
} from "./handlers";
import { realIndexFactory, type IndexAdapterFactory } from "./indexAdapter";
import { CodegraphSession } from "./session";

export interface CodegraphExtensionOptions {
  /**
   * Test seam: the Index factory the session runs on. Production omits it and
   * gets the real adapter; the entrypoint tests inject the in-memory one, so a
   * first-turn prewarm is observable and steerable without a native build.
   */
  factory?: IndexAdapterFactory;
}

export default function codegraphExtension(
  pi: ExtensionAPI,
  opts: CodegraphExtensionOptions = {},
): void {
  const session = new CodegraphSession({
    factory: opts.factory ?? realIndexFactory,
  });

  const bindUi = (ctx: ExtensionContext): void => {
    session.setUi({
      notify: (level, message) => {
        ctx.ui.notify(message, level);
      },
      status: (text) => {
        ctx.ui.setStatus("codegraph", text ?? undefined);
      },
    });
  };

  registerTools(pi, session);
  registerCommand(pi, session);

  // The note and the background first-use build are enabled only when at least
  // one codegraph tool is active in this session, and only where a codegraph
  // call can actually be served: a note that promises a build no call can
  // deliver sends the agent to a failing tool, which is the behavior this
  // extension exists to remove.
  pi.on("before_agent_start", (event, ctx) => {
    bindUi(ctx);
    const active = pi.getActiveTools();
    if (!CODEGRAPH_TOOL_NAMES.some((name) => active.includes(name))) {
      return undefined;
    }
    // The note decision and the prewarm need the same answer, so this hook walks
    // the project root once and hands that resolution to both (each git-root
    // probe costs two sync git calls). A tool call resolves for itself later;
    // nothing here runs the walk twice.
    const resolved = session.projectRootFor(ctx.cwd);
    session.prewarmFor(ctx.cwd, resolved);
    const state = session.indexStateFor(ctx.cwd, resolved);
    if (!state) return undefined;
    return {
      systemPrompt: `${event.systemPrompt}\n\n${promptNoteFor(state)}`,
    };
  });

  // Rebind the UI sink on every codegraph tool execution so notifications
  // and status line updates reach the current terminal.
  pi.on("tool_execution_start", (event, ctx) => {
    if (event.toolName.startsWith("codegraph_")) bindUi(ctx);
  });

  pi.on("session_shutdown", () => {
    session.closeAll();
  });
}
