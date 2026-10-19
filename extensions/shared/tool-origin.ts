/**
 * The shared Tool origin classifier (issue #154, ADR 0045).
 *
 * The Tool row header (ADR 0038) names the tool and its Tool origin: the
 * unit that supplied the tool - pi's own tool, an MCP server's tool, or one
 * extension's tool. Two surfaces show the same fact differently on purpose:
 * the transcript prints the Origin tag on every row (built-ins included, so
 * that no tag means exactly one thing: the origin is unknown), and the
 * /tools list keeps its compact convention of no tag for a built-in.
 *
 * The classifier answers the fact, not the rendering: it returns the
 * origin's kind (`builtin`, `mcp`, `extension`, or `unknown`) plus its tag
 * text. It is pure over pi's `ToolInfo` source metadata, so both surfaces
 * and the unit tests drive it without a live pi.
 *
 * The metadata bounds what it can say (pi 1.0.2, ADR 0045):
 * - Built-in tools report `source: "builtin"`, `path: "builtin:<name>"`.
 * - Every file-loaded extension reports the entry file's path, and npm,
 *   git, user-dir, and project-dir extensions report `source: "local"` with
 *   the entry file's directory as `baseDir`. A path given on the command
 *   line with `--extension` reports `source: "cli"` and no `baseDir`, so the
 *   directory comes from the path. The `scope` and `origin` fields are fixed
 *   defaults for extensions and carry nothing.
 * - pi's built-in MCP extension also reports `source: "builtin"` with
 *   `path: "builtin:mcp"`, so the metadata cannot separate an MCP tool from
 *   a built-in. Only pi's own `mcp__<server>__<tool>` name rule can, so the
 *   name rule runs before the metadata and also covers a name pi has not
 *   registered yet (an MCP row in a resumed session before its server
 *   connected).
 * - The `sdk` origin only appears in embedded runs, which never draw a Tool
 *   row in the TUI: it classifies as `unknown` and gets no tag.
 */
import type { SourceInfo, ToolInfo } from "@earendil-works/pi-coding-agent";

/** The kinds the classifier reports. `unknown` means pi reported nothing
 * usable for the name: no tag is printed, and no tag is never a guess. */
export type ToolOriginKind = "builtin" | "mcp" | "extension" | "unknown";

/** One tool's origin: the kind plus the Origin tag text. The tag is absent
 * for `unknown`; the other kinds always carry it. */
export interface ToolOrigin {
	kind: ToolOriginKind;
	tag?: string;
}

/** pi's own spelling for an MCP tool: `mcp__<server>__<tool>`, the rule pi's
 * MCP extension uses when it registers the tool (the same rule the Tool row
 * header's `server/tool` display name is made from). A name that matches no
 * second `__` group, such as `mcp__solo`, is not an MCP name. */
const MCP_TOOL_NAME = /^mcp__(.+?)__(.+)$/;

/** The server and tool names behind an MCP tool name, or `undefined` when
 * the name is not pi's MCP spelling. One owner of pi's name rule, shared
 * with the header's display name. */
export function mcpToolNameParts(toolName: string): { server: string; tool: string } | undefined {
	const match = MCP_TOOL_NAME.exec(toolName);
	return match ? { server: match[1], tool: match[2] } : undefined;
}

/** The file extensions an extension entry file carries. */
const ENTRY_FILE_EXT = /\.[cm]?[jt]s$/;

/** The last path segment of a path in either separator spelling, ignoring a
 * trailing separator. */
function baseName(path: string): string {
	const trimmed = path.replace(/[\\/]+$/, "");
	if (!trimmed) return path;
	const i = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
	return i === -1 ? trimmed : trimmed.slice(i + 1);
}

/** The name of the directory that holds the entry file, or the empty string
 * when the path names no directory. */
function parentDirName(path: string): string {
	const trimmed = path.replace(/[\\/]+$/, "");
	const i = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
	if (i <= 0) return "";
	const dir = trimmed.slice(0, i);
	const j = Math.max(dir.lastIndexOf("/"), dir.lastIndexOf("\\"));
	return j === -1 ? dir : dir.slice(j + 1);
}

/**
 * The extension's own name, the tag an extension's tool wears: if the entry
 * file is named `index`, the tag is the name of its directory, otherwise it
 * is the entry file's name without its extension. So
 * `extensions/codegraph/index.ts` gives `codegraph` and `extensions/tools.ts`
 * gives `tools`. The package name is never the tag: a git-installed package
 * path carries no package-name segment, and one name per package would say
 * `pi-extensions` on most rows without ever saying which extension.
 * For an `index` entry, pi's `baseDir` (the entry file's directory) wins
 * over the path when it is there; a path that names no directory falls back
 * to `index`.
 */
export function extensionTag(sourceInfo: SourceInfo): string {
	const stem = baseName(sourceInfo.path).replace(ENTRY_FILE_EXT, "");
	if (stem !== "index") return stem;
	const fromBaseDir = sourceInfo.baseDir ? baseName(sourceInfo.baseDir).replace(ENTRY_FILE_EXT, "") : "";
	const fromPath = parentDirName(sourceInfo.path);
	return fromBaseDir || fromPath || stem;
}

/**
 * Classify one tool: its Tool origin and Origin tag. The `mcp__` name rule
 * runs first and wins, because pi's metadata reports the tools of pi's
 * built-in MCP extension as built-in (`builtin:mcp`) and cannot separate
 * them. Then the metadata: `builtin` is pi's own tool (including the tools
 * of pi's built-in extensions), and `local` or `cli` is one extension's
 * tool named after that extension. Everything else - a name pi does not
 * report, an `sdk` origin - is `unknown` and gets no tag.
 */
export function classifyToolOrigin(toolName: string, sourceInfo: SourceInfo | undefined): ToolOrigin {
	if (mcpToolNameParts(toolName)) return { kind: "mcp", tag: "mcp" };
	if (!sourceInfo) return { kind: "unknown" };
	if (sourceInfo.source === "builtin") return { kind: "builtin", tag: "built-in" };
	if (sourceInfo.source === "local" || sourceInfo.source === "cli")
		return { kind: "extension", tag: extensionTag(sourceInfo) };
	return { kind: "unknown" };
}

/** The origin description the /tools list shows under the label: the same
 * fact the tag shows, in words. */
export function originDescription(toolName: string, sourceInfo: SourceInfo | undefined): string {
	const origin = classifyToolOrigin(toolName, sourceInfo);
	switch (origin.kind) {
		case "builtin":
			return "Built-in pi tool";
		case "mcp":
			return "Tool from an MCP server";
		case "extension":
			return `Extension tool from ${origin.tag}: ${sourceInfo?.path ?? ""}`;
		default:
			return "Tool with an unknown origin";
	}
}

/**
 * The memoized name-to-origin resolver: the registry is read once, on the
 * first lookup, and every later lookup answers from the memo. `pi.getAllTools()`
 * rebuilds its array on every call and `renderCall` runs on every repaint of
 * every row, so the read happens once for the life of the extension
 * instance, not per row. A reload re-runs the extension factory and re-reads
 * the registry, so the only stale case is one tool name claimed by two
 * extensions inside one session, which pi resolves by load order. A name the
 * read did not report (an MCP tool in a resumed session before its server
 * connected) gets the name rule and nothing else.
 *
 * @param readRegistry One read of pi's tool registry, e.g.
 * `() => pi.getAllTools()`. Runs at most once, on the first lookup.
 */
export function createToolOriginLookup(readRegistry: () => Iterable<ToolInfo>): (toolName: string) => ToolOrigin {
	let byName: Map<string, ToolOrigin> | undefined;
	return (toolName: string) => {
		if (!byName) {
			byName = new Map();
			for (const tool of readRegistry()) byName.set(tool.name, classifyToolOrigin(tool.name, tool.sourceInfo));
		}
		let origin = byName.get(toolName);
		if (!origin) {
			origin = classifyToolOrigin(toolName, undefined);
			byName.set(toolName, origin);
		}
		return origin;
	};
}
