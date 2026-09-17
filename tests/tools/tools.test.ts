/**
 * Tests for the tools extension (/tools): the default-disabled list of
 * user-only tools (issue #72). A session with no saved selection starts
 * with the listed tools inactive; a session with a saved selection restores
 * it exactly, and the defaults are not applied on top.
 *
 * The mock-extension-API pattern follows the codegraph entrypoint tests:
 * capture the activation calls and fire the session events without a live
 * pi.
 */
import { describe, expect, it } from "vitest";
import toolsExtension from "../../extensions/tools.ts";
import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";

const TOOL_NAMES = ["read", "bash", "edit", "write", "usage_report", "resource_toggle"];

function makeTool(name: string): ToolInfo {
  return {
    name,
    label: name,
    description: `test tool ${name}`,
    sourceInfo: { source: "builtin", path: `/x/${name}.ts`, scope: "global", origin: "top-level" },
  } as unknown as ToolInfo;
}

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
    getAllTools: () => TOOL_NAMES.map(makeTool),
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
