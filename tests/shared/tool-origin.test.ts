/**
 * Unit tests for the shared Tool origin classifier (issue #154, ADR 0045).
 *
 * The classifier answers the fact, not the rendering: fixture `sourceInfo`
 * values map to the origin's kind (`builtin`, `mcp`, `extension`,
 * `unknown`) plus its tag text. The `mcp__` name rule wins over the
 * metadata (pi reports its MCP tools as built-in), the extension tag is the
 * extension's own name, and the memoized resolver reads the registry once
 * for the life of the extension instance. No pi is loaded.
 */
import { describe, expect, it, vi } from "vitest";
import type { SourceInfo, ToolInfo } from "@earendil-works/pi-coding-agent";

import {
	classifyToolOrigin,
	createToolOriginLookup,
	extensionTag,
	mcpToolNameParts,
	originDescription,
} from "../../extensions/shared/tool-origin.ts";

/** One fixture sourceInfo, the shape pi reports. */
function sourceInfo(overrides: Partial<SourceInfo>): SourceInfo {
	return {
		path: "/home/julian/.pi/agent/extensions/example/index.ts",
		source: "local",
		scope: "user",
		origin: "top-level",
		...overrides,
	} as SourceInfo;
}

describe("classifyToolOrigin: the fixture sourceInfo values", () => {
	it("maps source builtin to builtin / built-in, pi's own tool", () => {
		const origin = classifyToolOrigin("read", sourceInfo({ source: "builtin", path: "builtin:read" }));
		expect(origin.kind).toBe("builtin");
		expect(origin.tag).toBe("built-in");
	});

	it("maps a git-package index entry to extension / its directory name", () => {
		const path = "/home/julian/.pi/agent/git/github.com/SeriousJul/pi-extensions/extensions/codegraph/index.ts";
		const origin = classifyToolOrigin("codegraph_search", sourceInfo({ source: "local", path, baseDir: path.replace(/index\.ts$/, "") }));
		expect(origin.kind).toBe("extension");
		expect(origin.tag).toBe("codegraph");
	});

	it("maps a git-package index entry without baseDir to its directory name from the path", () => {
		const path = "/home/julian/.pi/agent/git/github.com/SeriousJul/pi-extensions/extensions/codegraph/index.ts";
		const origin = classifyToolOrigin("codegraph_search", sourceInfo({ source: "local", path, baseDir: undefined }));
		expect(origin.kind).toBe("extension");
		expect(origin.tag).toBe("codegraph");
	});

	it("maps a single-file entry to extension / its file name without the extension", () => {
		const origin = classifyToolOrigin("tools", sourceInfo({ source: "local", path: "/home/julian/.pi/agent/extensions/tools.ts" }));
		expect(origin.kind).toBe("extension");
		expect(origin.tag).toBe("tools");
	});

	it("maps an npm node_modules entry to the entry's directory or file name, not the package name", () => {
		// A single-file entry: the tag is the file name, not the package.
		const file = classifyToolOrigin("web_search", sourceInfo({ source: "local", path: "/x/node_modules/pi-web-access/src/web-search.ts" }));
		expect(file.kind).toBe("extension");
		expect(file.tag).toBe("web-search");
		// An index entry: the tag is the entry's directory.
		const index = classifyToolOrigin("some_tool", sourceInfo({ source: "local", path: "/x/node_modules/some-pkg/index.js" }));
		expect(index.kind).toBe("extension");
		expect(index.tag).toBe("some-pkg");
	});

	it("maps a --extension path (source cli, no baseDir) to extension / its directory name", () => {
		const origin = classifyToolOrigin("note_search", sourceInfo({ source: "cli", path: "/tmp/pi-extensions-capture/note-search/index.mjs", scope: "temporary", baseDir: undefined }));
		expect(origin.kind).toBe("extension");
		expect(origin.tag).toBe("note-search");
	});

	it("gives no entry at all to unknown, with no tag", () => {
		const origin = classifyToolOrigin("ghost", undefined);
		expect(origin.kind).toBe("unknown");
		expect(origin.tag).toBeUndefined();
	});

	it("classifies an sdk origin as unknown: the tag list has no fourth tag", () => {
		const origin = classifyToolOrigin("usage_report", sourceInfo({ source: "sdk", path: "<sdk:usage_report>" }));
		expect(origin.kind).toBe("unknown");
		expect(origin.tag).toBeUndefined();
	});
});

describe("classifyToolOrigin: the mcp__ name rule", () => {
	it("tags a registered mcp tool mcp, even though pi reports it as builtin", () => {
		// pi's built-in MCP extension reports its tools as `builtin:mcp`.
		const origin = classifyToolOrigin("mcp__docs__search", sourceInfo({ source: "builtin", path: "builtin:mcp" }));
		expect(origin.kind).toBe("mcp");
		expect(origin.tag).toBe("mcp");
	});

	it("tags an unregistered mcp__server__tool mcp, the name rule with nothing else", () => {
		const origin = classifyToolOrigin("mcp__docs__search", undefined);
		expect(origin.kind).toBe("mcp");
		expect(origin.tag).toBe("mcp");
	});

	it("does not read the mcp__ prefix in a name with no second __ group", () => {
		const origin = classifyToolOrigin("mcp__solo", undefined);
		expect(origin.kind).toBe("unknown");
		expect(origin.tag).toBeUndefined();
	});

	it("keeps the non-greedy server split, matching pi's own rule", () => {
		expect(mcpToolNameParts("mcp__github__search__issue")).toEqual({ server: "github", tool: "search__issue" });
		expect(mcpToolNameParts("bash")).toBeUndefined();
	});
});

describe("extensionTag: the extension's own name", () => {
	it("names an index entry by its directory, from baseDir when pi sets it", () => {
		expect(extensionTag(sourceInfo({ path: "/x/extensions/codegraph/index.ts", baseDir: "/x/extensions/codegraph" }))).toBe("codegraph");
	});

	it("names an index entry by its directory from the path when baseDir is absent", () => {
		expect(extensionTag(sourceInfo({ path: "/x/extensions/codegraph/index.ts", baseDir: undefined }))).toBe("codegraph");
	});

	it("names every other entry by its file name without the extension", () => {
		expect(extensionTag(sourceInfo({ path: "/x/extensions/tools.ts" }))).toBe("tools");
		expect(extensionTag(sourceInfo({ path: "/x/extensions/tools.mjs" }))).toBe("tools");
		expect(extensionTag(sourceInfo({ path: "/x/extensions/tools.cts" }))).toBe("tools");
	});

	it("names a backslash path the same way", () => {
		expect(extensionTag(sourceInfo({ path: "C:\\x\\extensions\\codegraph\\index.ts", baseDir: undefined }))).toBe("codegraph");
	});
});

describe("originDescription: the same fact in words", () => {
	it("describes a built-in as pi's own tool", () => {
		expect(originDescription("read", sourceInfo({ source: "builtin", path: "builtin:read" }))).toBe("Built-in pi tool");
	});

	it("describes an mcp tool by its server origin", () => {
		expect(originDescription("mcp__docs__search", sourceInfo({ source: "builtin", path: "builtin:mcp" }))).toBe("Tool from an MCP server");
	});

	it("describes an extension tool by the extension's name and the entry path", () => {
		const info = sourceInfo({ source: "local", path: "/home/julian/.pi/agent/extensions/resource-toggle/index.ts" });
		expect(originDescription("resource_toggle", info)).toBe(
			"Extension tool from resource-toggle: /home/julian/.pi/agent/extensions/resource-toggle/index.ts",
		);
	});

	it("describes an unknown origin as unknown", () => {
		expect(originDescription("ghost", undefined)).toBe("Tool with an unknown origin");
	});
});

describe("createToolOriginLookup: one registry read, memoized", () => {
	const read = sourceInfo({ source: "builtin", path: "builtin:read" });
	const search = sourceInfo({ source: "local", path: "/x/node_modules/pi-code-search/index.ts" });
	const tools: ToolInfo[] = [
		{ name: "read", sourceInfo: read } as unknown as ToolInfo,
		{ name: "search", sourceInfo: search } as unknown as ToolInfo,
	];

	it("reads the registry once when the resolver is called twice", () => {
		const readRegistry = vi.fn(() => tools);
		const lookup = createToolOriginLookup(readRegistry);
		expect(lookup("read")).toEqual({ kind: "builtin", tag: "built-in" });
		expect(lookup("search")).toEqual({ kind: "extension", tag: "pi-code-search" });
		expect(readRegistry).toHaveBeenCalledTimes(1);
	});

	it("answers every later lookup from the memo, including names the read missed", () => {
		const readRegistry = vi.fn(() => tools);
		const lookup = createToolOriginLookup(readRegistry);
		lookup("read");
		lookup("search");
		lookup("mcp__docs__search"); // not in the registry: the name rule, memoized
		lookup("read");
		expect(readRegistry).toHaveBeenCalledTimes(1);
		expect(lookup("read").kind).toBe("builtin");
		expect(lookup("search").kind).toBe("extension");
		expect(lookup("mcp__docs__search").tag).toBe("mcp");
	});
});
