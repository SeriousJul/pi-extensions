/**
 * The six codegraph tools (names, parameters, and descriptions mirror the
 * upstream MCP tools, minus the projectPath parameter: the index is always
 * the one for the call's own worktree), plus the /codegraph command.
 */
import path from "node:path";
import { Type } from "typebox";
import type { NodeKind } from "@colbymchenry/codegraph";
import {
  unavailableText,
  reasonOf,
  renderSearch,
  renderSymbol,
  renderFileView,
  renderRefs,
  renderImpact,
  renderExplore,
} from "./format";
import { resolveRoot } from "./root";
import type { CodegraphSession, ReadyInfo } from "./session";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@earendil-works/pi-agent-core";

export const PROMPT_NOTE = [
  "This project has a codegraph index. It reflects the current git worktree and stays current automatically.",
  "For questions about how code works, and before editing a symbol or file, call `codegraph_explore` first instead of a grep/read loop.",
  "Use `codegraph_node` to read a file or a single symbol.",
  "Do not try to build or reindex the codegraph index yourself.",
].join(" ");

const NodeKinds = Type.Optional(
  Type.Array(
    Type.Union([
      Type.Literal("function"),
      Type.Literal("method"),
      Type.Literal("class"),
      Type.Literal("interface"),
      Type.Literal("type"),
      Type.Literal("variable"),
      Type.Literal("route"),
      Type.Literal("component"),
    ]),
  ),
);

const FileParam = Type.Optional(
  Type.String({
    description:
      "A file path, or the /sub/dir part of an indexed path, to disambiguate a symbol name.",
  }),
);

const LineParam = Type.Optional(
  Type.Integer({
    minimum: 1,
    description: "A line number to disambiguate a symbol name.",
  }),
);

type ToolResult = AgentToolResult<unknown>;

function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }], details: undefined };
}

function fail(err: unknown): ToolResult {
  const reason = reasonOf(err);
  return {
    content: [{ type: "text", text: unavailableText(reason) }],
    details: undefined,
  };
}

type Execute = (
  toolCallId: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<unknown> | undefined,
  ctx: ExtensionContext,
) => Promise<ToolResult>;

/**
 * Build the shared tool execute wrapper: resolve the index for the call's
 * worktree (blocking until it is ready), run the renderer, and map every
 * failure - including mid-query index problems - to the standard fallback
 * line.
 *
 * `anchorFile` marks tools whose `file` parameter names the file to read
 * (codegraph_node file mode); that file anchors the root resolution. In the
 * other tools `file` only disambiguates a symbol and the root stays the
 * call's working directory.
 */
function makeExecute(
  session: CodegraphSession,
  run: (
    info: ReadyInfo,
    params: Record<string, unknown>,
  ) => string | Promise<string>,
  anchorFile = false,
): Execute {
  return async (_toolCallId, params, _signal, _onUpdate, ctx) => {
    try {
      let effective = params;
      const anchor = anchorFile && params.file !== undefined;
      const info = await session.queryReady(
        ctx.cwd,
        anchor ? String(params.file) : undefined,
      );
      if (anchor) {
        // The file argument was resolved against the call's cwd, but index
        // paths are relative to the resolved root. When the anchor put the
        // root somewhere else (a file in a sibling worktree), re-express the
        // file relative to that root for the lookup.
        const abs = path.resolve(ctx.cwd, String(params.file));
        const rel = path.relative(info.root, abs);
        if (
          !path.isAbsolute(rel) &&
          !rel.startsWith("..") &&
          rel !== String(params.file)
        ) {
          effective = { ...params, file: rel };
        }
      }
      return ok(await run(info, effective));
    } catch (err) {
      return fail(err);
    }
  };
}

/** Register the six codegraph tools. */
export function registerTools(pi: ExtensionAPI, session: CodegraphSession): void {
  pi.registerTool({
    name: "codegraph_search",
    label: "codegraph search",
    description:
      "Quick symbol search by name. Returns locations only (no code). Use codegraph_explore instead to get the actual source / understand an area in one call.",
    promptSnippet:
      "codegraph_search: find symbols by name (locations only).",
    parameters: Type.Object({
      query: Type.String({ description: "Symbol name or partial name to search for." }),
      kind: NodeKinds,
      limit: Type.Optional(
        Type.Integer({ description: "Maximum results (default 10).", default: 10 }),
      ),
      offset: Type.Optional(
        Type.Integer({ description: "Skip the first N results for pagination.", default: 0 }),
      ),
    }),
    execute: makeExecute(session, (info, params) =>
      renderSearch(
        info.cg,
        String(params.query),
        params.kind as NodeKind[] | undefined,
        typeof params.limit === "number" ? params.limit : 10,
        typeof params.offset === "number" ? params.offset : 0,
      ),
    ),
  });

  pi.registerTool({
    name: "codegraph_callers",
    label: "codegraph callers",
    description: "List functions that call <symbol>. For the full flow, use codegraph_explore.",
    promptSnippet: "codegraph_callers: list what calls a symbol.",
    parameters: Type.Object({
      symbol: Type.String({ description: "Name of the function or method." }),
      file: FileParam,
      line: LineParam,
    }),
    execute: makeExecute(
      session,
      (info, params) =>
        renderRefs(
          info.cg,
          String(params.symbol),
          "callers",
          params.file !== undefined ? String(params.file) : undefined,
          typeof params.line === "number" ? params.line : undefined,
        ),
    ),
  });

  pi.registerTool({
    name: "codegraph_callees",
    label: "codegraph callees",
    description: "List functions called by <symbol>. For the full flow, use codegraph_explore.",
    promptSnippet: "codegraph_callees: list what a symbol calls.",
    parameters: Type.Object({
      symbol: Type.String({ description: "Name of the function or method." }),
      file: FileParam,
      line: LineParam,
    }),
    execute: makeExecute(
      session,
      (info, params) =>
        renderRefs(
          info.cg,
          String(params.symbol),
          "callees",
          params.file !== undefined ? String(params.file) : undefined,
          typeof params.line === "number" ? params.line : undefined,
        ),
    ),
  });

  pi.registerTool({
    name: "codegraph_impact",
    label: "codegraph impact",
    description: "Show what could break if <symbol> changes. Lists dependent code by depth.",
    promptSnippet: "codegraph_impact: show what breaks when a symbol changes.",
    parameters: Type.Object({
      symbol: Type.String({ description: "Name of the symbol to analyze." }),
      depth: Type.Optional(
        Type.Integer({ description: "How many hops of dependency traversal to traverse (default 2).", default: 2, minimum: 1 }),
      ),
      file: FileParam,
      line: LineParam,
    }),
    execute: makeExecute(
      session,
      (info, params) =>
        renderImpact(
          info.cg,
          String(params.symbol),
          typeof params.depth === "number" ? params.depth : 2,
          params.file !== undefined ? String(params.file) : undefined,
          typeof params.line === "number" ? params.line : undefined,
        ),
    ),
  });

  pi.registerTool({
    name: "codegraph_node",
    label: "codegraph node",
    description:
      "Read a single file or symbol. With `file`: reads the file like the Read tool (line numbers, offset/limit) plus a dependents header. With `symbol`: location, signature, body (includeCode), and top callers/callees.",
    promptSnippet: "codegraph_node: read one file or symbol with graph context.",
    parameters: Type.Object({
      file: FileParam,
      symbol: Type.Optional(
        Type.String({ description: "Name of the symbol to read." }),
      ),
      includeCode: Type.Optional(
        Type.Boolean({
          description: "Include the full source code (default: true).",
        }),
      ),
      offset: Type.Optional(
        Type.Integer({ description: "Starting line number (file mode, default 1).", default: 1, minimum: 1 }),
      ),
      limit: Type.Optional(
        Type.Integer({ description: "Maximum lines to return (file mode, default 2000).", default: 2000, minimum: 1 }),
      ),
      symbolsOnly: Type.Optional(
        Type.Boolean({
          description: "Return only the structural map: signatures with line ranges, no bodies (file mode).",
        }),
      ),
    }),
    execute: makeExecute(session, (info, params) => {
      if (params.file !== undefined) {
        return renderFileView(
          info.cg,
          info.root,
          String(params.file),
          typeof params.offset === "number" ? params.offset : 1,
          typeof params.limit === "number" ? params.limit : 2000,
          params.symbolsOnly === true,
        );
      }
      if (params.symbol !== undefined) {
        return renderSymbol(
          info.cg,
          info.root,
          String(params.symbol),
          params.includeCode !== false,
          undefined,
          undefined,
        );
      }
      return "Either `file` or `symbol` must be provided.";
    }, true),
  });

  pi.registerTool({
    name: "codegraph_explore",
    label: "codegraph explore",
    description:
      "Understand specific code areas or tasks. Inspect relevant symbols' source, call paths, and relationships in one call. Prefer this over multiple codegraph_node calls when exploring how several symbols work together.",
    promptSnippet: "codegraph_explore: get source and call paths for an area in one call.",
    parameters: Type.Object({
      query: Type.String({
        description: "Symbol names, file names, or short natural language.",
      }),
      maxFiles: Type.Optional(
        Type.Integer({ description: "Maximum number of files to include source for (default 12).", default: 12, minimum: 1 }),
      ),
    }),
    execute: makeExecute(session, (info, params) =>
      renderExplore(
        info.cg,
        info.root,
        String(params.query),
        typeof params.maxFiles === "number" ? params.maxFiles : 12,
      ),
    ),
  });
}

// ------------------------------------------------------------------
// /codegraph command
// ------------------------------------------------------------------

function fmtTime(ts?: number): string {
  if (!ts) return "never";
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

function statusLines(session: CodegraphSession, ctx: ExtensionContext): string[] {
  try {
    const s = session.statusFor(ctx.cwd);
    const lines: string[] = [];
    lines.push(`codegraph: ${s.root}`);
    if (s.mainCheckout && !s.isMainCheckout) {
      lines.push(`  worktree (main checkout: ${s.mainCheckout})`);
    }
    if (s.needsCreate) {
      lines.push("  index: none yet (built automatically on first use)");
      return lines;
    }
    if (s.instanceOpen && s.stats) {
      lines.push(
        `  index: ${s.stats.fileCount} files, ${s.stats.nodeCount} symbols`,
      );
    } else {
      lines.push("  index: on disk (open on first use)");
    }
    lines.push(`  last reconcile: ${fmtTime(s.lastReconcileAt)}`);
    if (s.seedSource) {
      lines.push(`  seeded from: ${s.seedSource}`);
    }
    if (s.watcher === "off") {
      lines.push("  watcher: not started");
    } else if (s.watcher === "active") {
      lines.push("  watcher: active");
    } else {
      lines.push(`  watcher: ${s.watcher} (${s.watcherReason ?? "unknown"})`);
    }
    lines.push(`  auto-index: ${session.autoIndex ? "on" : "off"}`);
    return lines;
  } catch (err) {
    return [`codegraph: ${reasonOf(err)}`];
  }
}

export interface CommandUi {
  notify(type: "info" | "warning" | "error", message: string): void;
  confirm?(title: string, message: string): Promise<boolean>;
  setWidget?(key: string, content: string[] | undefined): void;
}

function uiFromCtx(ctx: ExtensionContext): CommandUi {
  return {
    notify: (type, message) => ctx.ui.notify(message, type),
    confirm: ctx.ui.confirm
      ? (title, message) => ctx.ui.confirm(title, message)
      : undefined,
    setWidget: ctx.ui.setWidget
      ? (key, content) => ctx.ui.setWidget(key, content)
      : undefined,
  };
}

export function registerCommand(pi: ExtensionAPI, session: CodegraphSession): void {
  pi.registerCommand("codegraph", {
    description:
      "Manage the codegraph index: status, init (full rebuild), seed [path], uninit, auto on|off",
    handler: async (args: string, ctx: ExtensionContext) => {
      const ui = uiFromCtx(ctx);
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const verb = parts[0] ?? "status";
      try {
        if (verb === "status" || verb === "") {
          const lines = statusLines(session, ctx);
          ui.setWidget?.("codegraph", lines);
          ui.notify("info", lines.join("\n"));
          return;
        }
        if (verb === "init") {
          session
            .rebuild(ctx.cwd)
            .then((info) => {
              ui.setWidget?.("codegraph", undefined);
              ui.notify(
                "info",
                `codegraph: index rebuilt at ${info.root} (${info.cg.getStats().fileCount} files, ${info.cg.getStats().nodeCount} symbols)`,
              );
            })
            .catch((err) => {
              ui.setWidget?.("codegraph", undefined);
              ui.notify("warning", reasonOf(err));
            });
          return;
        }
        if (verb === "seed") {
          session
            .reseed(ctx.cwd, parts[1])
            .then((info) => {
              ui.setWidget?.("codegraph", undefined);
              const changed = info.justSeeded?.changedFiles ?? 0;
              ui.notify(
                "info",
                `codegraph: index at ${info.root} seeded from ${info.justSeeded?.source}; reconcile changed ${changed} file${changed === 1 ? "" : "s"}`,
              );
            })
            .catch((err) => {
              ui.setWidget?.("codegraph", undefined);
              ui.notify("warning", reasonOf(err));
            });
          return;
        }
        if (verb === "uninit") {
          // Confirm first; nothing is deleted until the user agrees.
          let root: string;
          try {
            root = resolveRoot(ctx.cwd).root;
          } catch (err) {
            ui.notify("warning", reasonOf(err));
            return;
          }
          const yes = ui.confirm
            ? await ui.confirm(
                "Remove codegraph index?",
                `The codegraph index at ${root} will be deleted.`,
              )
            : false;
          if (!yes) {
            ui.notify("info", "codegraph: uninit cancelled");
            return;
          }
          const res = await session.uninit(ctx.cwd);
          ui.setWidget?.("codegraph", undefined);
          ui.notify(
            "info",
            res.removed
              ? `codegraph: removed index at ${res.root}`
              : `codegraph: no index at ${res.root}`,
          );
          return;
        }
        if (verb === "auto") {
          const value = parts[1];
          if (value !== "on" && value !== "off") {
            ui.notify("warning", "codegraph: usage: /codegraph auto on|off");
            return;
          }
          session.setAutoIndex(value === "on");
          ui.notify("info", `codegraph: auto-index ${value}`);
          return;
        }
        ui.notify(
          "warning",
          `codegraph: unknown verb "${verb}". Use: status, init, seed [path], uninit, auto on|off`,
        );
      } catch (err) {
        ui.notify("warning", reasonOf(err));
      }
    },
  });
}
