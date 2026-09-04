/**
 * codegraph extension entrypoint.
 *
 * Embeds the codegraph library in-process (no MCP, no daemon): registers the
 * six codegraph tools and the /codegraph command, and keeps one CodeGraph
 * instance open per project root in this pi session. Every worktree of a
 * git repository gets its own index, seeded from a sibling worktree's index
 * and kept current by codegraph's own file watcher (with a reconcile before
 * every query when watching is degraded).
 *
 * The env defaults that must precede the codegraph library load live in
 * runtime.ts (loaded through the session's import of it), ahead of the
 * library load in file order, so no file can load the library without
 * them.
 */
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { PROMPT_NOTE, registerCommand, registerTools } from "./handlers";
import { CodegraphSession } from "./session";

export default function codegraphExtension(pi: ExtensionAPI): void {
  const session = new CodegraphSession();

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

  // The prompt note goes in only when the index for the working directory's
  // root is ready; the first agent turn still triggers the lazy build.
  pi.on("before_agent_start", (event, ctx) => {
    bindUi(ctx);
    if (session.isReadyFor(ctx.cwd)) {
      return { systemPrompt: `${event.systemPrompt}\n\n${PROMPT_NOTE}` };
    }
    return undefined;
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
