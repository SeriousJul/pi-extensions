/**
 * The six codegraph tools (names, parameters, and descriptions mirror the
 * upstream MCP tools, minus the projectPath parameter: the index is always
 * the one for the call's own worktree), plus the /codegraph command.
 */
import path from "node:path";
import { Type } from "typebox";
import type { NodeKind } from "./indexAdapter";
import { realIndexFactory } from "./indexAdapter";
import { setDefaultIndexFactory } from "./factory-registry";
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
import type { CodegraphSession, ReadyInfo } from "./session";

// This module is loaded when the tools are registered (production entry
// point and integration test), so it is the right place to register the
// real Index factory as the default: a factory-less session's sync entry
// points resolve it without a lazy load (spec 0003).
setDefaultIndexFactory(realIndexFactory);
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

const NodeKindUnion = Type.Union([
  Type.Literal("function"),
  Type.Literal("method"),
  Type.Literal("class"),
  Type.Literal("interface"),
  Type.Literal("type"),
  Type.Literal("variable"),
  Type.Literal("route"),
  Type.Literal("component"),
]);

// Upstream takes a single kind string; this also accepts an array of kinds
// (a superset, normalized in the handler).
const NodeKinds = Type.Optional(
  Type.Union([NodeKindUnion, Type.Array(NodeKindUnion)], {
    description:
      "Filter by node kind - a single kind (the upstream shape) or an array of kinds",
  }),
);

/** The upstream `kind` is one kind string; an array form is also accepted. */
function normalizeKinds(kind: unknown): NodeKind[] | undefined {
  if (kind === undefined) return undefined;
  if (typeof kind === "string") return [kind as NodeKind];
  if (Array.isArray(kind)) return kind as NodeKind[];
  return undefined;
}

const FileParam = Type.Optional(
  Type.String({
    description:
      "Narrow to the definition in this file (path or suffix) when several same-named symbols exist",
  }),
);

const NodeFileParam = Type.Optional(
  Type.String({
    description:
      'A file path or basename (e.g. "harness.rs", "src/auth/session.ts"). ' +
      "Pass it ALONE (no symbol) to READ the file like the built-in read " +
      "tool - its full source with line numbers + which files depend on it. " +
      "Or pass it WITH a symbol to disambiguate an overloaded name to the " +
      "definition in this file.",
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
      query: Type.String({
        description:
          'Symbol name or partial name (e.g., "auth", "signIn", "UserService")',
      }),
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
        normalizeKinds(params.kind),
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
      symbol: Type.String({
        description:
          "Name of the function, method, or class to find callers for",
      }),
      file: FileParam,
      line: LineParam,
      limit: Type.Optional(
        Type.Integer({
          description: "Maximum number of callers to return (default: 20)",
          default: 20,
        }),
      ),
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
          typeof params.limit === "number" ? params.limit : undefined,
        ),
    ),
  });

  pi.registerTool({
    name: "codegraph_callees",
    label: "codegraph callees",
    description: "List functions that <symbol> calls. For the full flow, use codegraph_explore.",
    promptSnippet: "codegraph_callees: list what a symbol calls.",
    parameters: Type.Object({
      symbol: Type.String({
        description:
          "Name of the function, method, or class to find callees for",
      }),
      file: FileParam,
      line: LineParam,
      limit: Type.Optional(
        Type.Integer({
          description: "Maximum number of callees to return (default: 20)",
          default: 20,
        }),
      ),
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
          typeof params.limit === "number" ? params.limit : undefined,
        ),
    ),
  });

  pi.registerTool({
    name: "codegraph_impact",
    label: "codegraph impact",
    description: "List symbols affected by changing <symbol>. Use before a refactor.",
    promptSnippet: "codegraph_impact: show what breaks when a symbol changes.",
    parameters: Type.Object({
      symbol: Type.String({
        description: "Name of the symbol to analyze impact for",
      }),
      depth: Type.Optional(
        Type.Integer({ description: "How many levels of dependencies to traverse (default: 2)", default: 2, minimum: 1 }),
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
      "Two modes. (1) READ A FILE - use INSTEAD of the built-in read tool: " +
      "pass `file` (a path or basename) with no `symbol` and it returns that " +
      "file's current on-disk source with line numbers, exactly the shape read " +
      "gives you (`<n>\\t<line>`, safe to edit from), narrowable with " +
      "`offset`/`limit` just like read - PLUS a one-line note of which files " +
      "depend on it. Same bytes as read (always the current on-disk source, " +
      "never stale), with the blast radius attached. Use it whenever you would read a source " +
      "file. (2) ONE SYMBOL you can name - its location, signature, verbatim " +
      "source (includeCode=true) and caller/callee trail in one call, so before " +
      "changing it you see what calls it and what your edit would break. For an " +
      "AMBIGUOUS name it returns EVERY matching definition's body in one call " +
      "(so you never read a file to find the right overload); pass " +
      "`file`/`line` to pin one. Use codegraph_explore for several related " +
      "symbols or the full flow.",
    promptSnippet: "codegraph_node: read one file or symbol with graph context.",
    parameters: Type.Object({
      file: NodeFileParam,
      symbol: Type.Optional(
        Type.String({
          description:
            "Name of the symbol to read (symbol mode). Omit it and pass " +
            "`file` alone to read a whole file like the built-in read tool.",
        }),
      ),
      includeCode: Type.Optional(
        Type.Boolean({
          description:
            "Symbol mode: include the symbol's full body (default: true, " +
            "differs from upstream's default: false; the spec mandates it). " +
            "Ignored in file mode, which always returns source unless " +
            "`symbolsOnly` is set.",
        }),
      ),
      offset: Type.Optional(
        Type.Integer({ description: "File mode: 1-based line to start reading from, exactly like the read tool's offset. Defaults to the start of the file.", default: 1, minimum: 1 }),
      ),
      limit: Type.Optional(
        Type.Integer({ description: "File mode: maximum number of lines to return, exactly like the read tool's limit. Defaults to the whole file (capped at 2000 lines, like read).", default: 2000, minimum: 1 }),
      ),
      symbolsOnly: Type.Optional(
        Type.Boolean({
          description:
            "File mode: return just the file's symbol map + dependents (a cheap structural overview) instead of its source.",
        }),
      ),
      line: Type.Optional(
        Type.Integer({
          minimum: 1,
          description:
            "Symbol mode only: disambiguate to the definition at/around this line (use with the file:line a trail showed you).",
        }),
      ),
    }),
    execute: makeExecute(session, (info, params) => {
      // Symbol mode wins when both are given: `file` then narrows the symbol
      // to the definition in that file (the spec's file+symbol priority).
      // File mode only when `symbol` is absent.
      if (params.symbol !== undefined) {
        return renderSymbol(
          info.cg,
          info.root,
          String(params.symbol),
          params.includeCode !== false,
          params.file !== undefined ? String(params.file) : undefined,
          typeof params.line === "number" ? params.line : undefined,
        );
      }
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
      return "Either `file` or `symbol` must be provided.";
    }, true),
  });

  pi.registerTool({
    name: "codegraph_explore",
    label: "codegraph explore",
    description:
      "PRIMARY TOOL - call FIRST for almost any question OR before an edit: " +
      "how does X work, architecture, a bug, where/what is X, surveying an " +
      "area, or the symbols you are about to change. Returns the verbatim " +
      "source of the relevant symbols grouped by file in ONE capped call " +
      "(read-equivalent - treat the shown source as already read; do NOT " +
      "re-open those files), plus the call path among them. Query can be a " +
      "natural-language question OR a bag of symbol/file names. Usually the " +
      "ONLY call you need - more accurate context, in far fewer tokens and " +
      "round-trips than a search/read/grep loop.",
    promptSnippet: "codegraph_explore: get source and call paths for an area in one call.",
    parameters: Type.Object({
      query: Type.String({
        description:
          "Symbol names, file names, or short code terms to explore (e.g., " +
          "\"AuthService loginUser session-manager\", \"GraphTraverser BFS " +
          "impact traversal.ts\"). For a flow question, name the symbols " +
          "spanning the flow (e.g. \"mutateElement renderScene\"). A " +
          "natural-language question works too - no prior codegraph_search " +
          "needed.",
      }),
      maxFiles: Type.Optional(
        Type.Integer({ description: "Maximum number of files to include source code from (default: 12)", default: 12, minimum: 1 }),
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
    if (s.stats) {
      lines.push(
        `  index: ${s.stats.fileCount} files, ${s.stats.nodeCount} nodes, ${s.stats.edgeCount} edges`,
      );
      if (s.indexState) {
        lines.push(`  index state: ${s.indexState}`);
      }
    } else {
      lines.push("  index: on disk (counts unavailable)");
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
            root = session.resolveRootFor(ctx.cwd).root;
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
