/**
 * Tests for the tools extension (/tools): the default-disabled list of
 * user-only tools (issue #72), and the rows over the shared Tool origin
 * classifier (issue #154, ADR 0045).
 *
 * A session with no saved selection starts with the listed tools inactive;
 * a session with a saved selection restores it exactly, and the defaults are
 * not applied on top. The mock-extension-API pattern follows the codegraph
 * entrypoint tests: capture the activation calls and fire the session events
 * without a live pi. The row tests mount the same functions the /tools list
 * and the screenshot pipeline mount, over a fake theme that emits no escape
 * codes, so the rows are asserted as plain text.
 */
import { describe, expect, it } from "vitest";
import toolsExtension, { toolSettingItems, toolsHeader } from "../../extensions/tools.ts";
import type { ExtensionAPI, SourceInfo, Theme, ToolInfo } from "@earendil-works/pi-coding-agent";

const TOOL_NAMES = ["read", "bash", "edit", "write", "usage_report", "resource_toggle"];

function makeTool(name: string, sourceInfo?: Partial<SourceInfo>): ToolInfo {
  return {
    name,
    label: name,
    description: `test tool ${name}`,
    sourceInfo: { source: "builtin", path: `/x/${name}.ts`, scope: "global", origin: "top-level", ...sourceInfo },
  } as unknown as ToolInfo;
}

/** A theme that emits no escape codes, so the rows are plain text. */
const fakeTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

interface Harness {
  /** Every setActiveTools call, in order, as the names it received. */
  setActiveCalls: string[][];
  sessionStart: () => void;
  sessionTree: () => void;
}

function makeHarness(branch: unknown[], active: string[] = [...TOOL_NAMES]): Harness {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const harness: Harness = {
    setActiveCalls: [],
    sessionStart: () => {
      throw new Error("session_start not wired");
    },
    sessionTree: () => {
      throw new Error("session_tree not wired");
    },
  };
  const ctx = {
    cwd: "/tmp/project",
    sessionManager: { getBranch: () => branch },
    ui: { notify: () => undefined },
  };
  const pi = {
    getAllTools: () => TOOL_NAMES.map((n) => makeTool(n)),
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => {
      harness.setActiveCalls.push([...names]);
    },
    appendEntry: (_type: string, _data: unknown) => undefined,
    registerCommand: (_name: string, _def: unknown) => undefined,
    on: (name: string, fn: (event: unknown, ctx: unknown) => unknown) => {
      handlers.set(name, fn);
    },
  } as unknown as ExtensionAPI;
  toolsExtension(pi);
  harness.sessionStart = () => void handlers.get("session_start")!(null, ctx);
  harness.sessionTree = () => void handlers.get("session_tree")!(null, ctx);
  return harness;
}

/** One persisted /tools selection on the branch. */
const saved = (enabledTools: string[]) => ({
  type: "custom",
  customType: "tools-config",
  data: { enabledTools },
});

describe("default-disabled user-only tools (issue #72)", () => {
  it("starts a session with no saved state with the user-only tools inactive", () => {
    const h = makeHarness([]);
    h.sessionStart();
    expect(h.setActiveCalls).toHaveLength(1);
    expect(h.setActiveCalls[0].sort()).toEqual(["bash", "edit", "read", "write"]);
  });

  it("restores a saved selection exactly, without applying the defaults on top", () => {
    const h = makeHarness([saved(["read", "usage_report", "resource_toggle"])]);
    h.sessionStart();
    expect(h.setActiveCalls).toHaveLength(1);
    expect(h.setActiveCalls[0].sort()).toEqual(["read", "resource_toggle", "usage_report"]);
  });

  it("filters a saved selection to tools that still exist", () => {
    const h = makeHarness([saved(["read", "gone_away", "usage_report"])]);
    h.sessionStart();
    expect(h.setActiveCalls[0].sort()).toEqual(["read", "usage_report"]);
  });

  it("re-applies the defaults on tree navigation while no selection is saved", () => {
    const h = makeHarness([]);
    h.sessionStart();
    h.sessionTree();
    expect(h.setActiveCalls).toHaveLength(2);
    expect(h.setActiveCalls[1].sort()).toEqual(["bash", "edit", "read", "write"]);
  });

	  it("keeps the saved selection on tree navigation once it exists", () => {
    const branch = [saved(["bash", "usage_report"])];
    const h = makeHarness(branch);
    h.sessionStart();
    h.sessionTree();
    expect(h.setActiveCalls).toHaveLength(2);
    for (const call of h.setActiveCalls) expect(call.sort()).toEqual(["bash", "usage_report"]);
  });
});

describe("/tools rows over the shared Tool origin classifier (issue #154)", () => {
	it("shows no tag for a built-in, keeping the list's compact convention", () => {
		const items = toolSettingItems([makeTool("read")], () => true, fakeTheme);
		expect(items[0].label).toBe("read");
		expect(items[0].description).toBe("Built-in pi tool");
	});

	it("names a git-package extension by its directory, where it used to say index", () => {
		const items = toolSettingItems(
			[makeTool("resource_toggle", { source: "local", path: "/x/extensions/resource-toggle/index.ts", baseDir: "/x/extensions/resource-toggle" })],
			() => true,
			fakeTheme,
		);
		expect(items[0].label).toBe("resource_toggle (resource-toggle)");
		expect(items[0].description).toBe("Extension tool from resource-toggle: /x/extensions/resource-toggle/index.ts");
	});

	it("names a single-file extension by its file name without the extension", () => {
		const items = toolSettingItems([makeTool("web_search", { source: "local", path: "/x/extensions/web-search.ts" })], () => true, fakeTheme);
		expect(items[0].label).toBe("web_search (web-search)");
	});

	it("tags an MCP tool mcp, the name rule winning over its builtin metadata", () => {
		const items = toolSettingItems([makeTool("mcp__docs__search", { source: "builtin", path: "builtin:mcp" })], () => true, fakeTheme);
		expect(items[0].label).toBe("mcp__docs__search (mcp)");
		expect(items[0].description).toBe("Tool from an MCP server");
	});

	it("shows no tag for an unknown origin, and describes it as such", () => {
		const items = toolSettingItems([makeTool("ghost", { source: "sdk", path: "<sdk:ghost>" })], () => true, fakeTheme);
		expect(items[0].label).toBe("ghost");
		expect(items[0].description).toBe("Tool with an unknown origin");
	});

	it("keeps the enable state on the row next to the tag", () => {
		const items = toolSettingItems([makeTool("resource_toggle", { source: "local", path: "/x/extensions/resource-toggle/index.ts" })], () => false, fakeTheme);
		expect(items[0].currentValue).toBe("disabled");
		expect(items[0].label).toBe("resource_toggle (resource-toggle)");
	});
});

describe("the /tools header text", () => {
	it("says the tag is the Tool origin, mentions no SDK, and keeps no tag = built-in", () => {
		const lines = toolsHeader(fakeTheme).render(100);
		expect(lines[0]).toBe("Tool Configuration");
		expect(lines[1]).toBe("Tag = Tool origin. No tag = built-in.");
		expect(lines.join("\n").toLowerCase()).not.toContain("sdk");
	});
});
