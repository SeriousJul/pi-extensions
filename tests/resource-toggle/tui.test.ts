/**
 * TUI tests for the resource list: drive the component with key events
 * against fake terminal and theme objects, asserting rendered lines and
 * the resulting state.
 */
import type { TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createResourceToggleTui } from "../../extensions/resource-toggle/tui.ts";
import type { MachineContext, ResourceInfo, SettingsState } from "../../extensions/resource-toggle/lib/types.ts";
import { emptyScopeArrays } from "../../extensions/resource-toggle/lib/types.ts";
import type { WriteOutcome } from "../../extensions/resource-toggle/lib/writer.ts";

const fakeTheme = {
  fg: (_c: string, s: string) => s,
  bg: (_c: string, s: string) => s,
  bold: (s: string) => s,
} as unknown as Theme;
const fakeTui = { requestRender: () => {}, terminal: { rows: 40, columns: 120 } } as unknown as TUI;

const machine: MachineContext = { cwd: "/proj", agentDir: "/home/u/.pi/agent", configDir: ".pi" };

const res = (partial: Partial<ResourceInfo> & { path: string; displayName: string }): ResourceInfo => ({
  type: partial.type ?? "extensions",
  path: partial.path,
  displayName: partial.displayName,
  scope: partial.scope ?? "user",
  origin: partial.origin ?? "top-level",
  source: "auto",
  baseDir: partial.baseDir,
  enabled: partial.enabled ?? true,
  ownEnabled: partial.ownEnabled ?? true,
});

const resources: ResourceInfo[] = [
  res({ path: "/home/u/.pi/agent/extensions/dummy.ts", displayName: "dummy.ts" }),
  res({ path: "/proj/.pi/extensions/proj.ts", displayName: "proj.ts", scope: "project" }),
  res({ path: "/home/u/.pi/agent/skills/my-skill/SKILL.md", displayName: "my-skill", type: "skills" }),
  res({ path: "/pkg/ext/tool.ts", displayName: "tool.ts", origin: "package", source: "acme/pkg" }),
];

interface Rig {
  component: ReturnType<typeof createResourceToggleTui>;
  applyCalls: SettingsState[];
  closed: { called: boolean; changed?: boolean };
  render: (w?: number) => string[];
  press: (data: string) => void;
  tick: () => Promise<void>;
}

function makeRig(settings?: SettingsState, applyImpl?: (next: SettingsState) => Promise<WriteOutcome>): Rig {
  const applyCalls: SettingsState[] = [];
  const closed = { called: false } as { called: boolean; changed?: boolean };
  const component = createResourceToggleTui({
    tui: fakeTui,
    theme: fakeTheme,
    resources,
    settings: settings ?? { global: emptyScopeArrays(), project: emptyScopeArrays() },
    machine,
    projectTrusted: true,
    apply: (_prev, next) => {
      applyCalls.push(next);
      return applyImpl ? applyImpl(next) : Promise.resolve({ ok: true });
    },
    viewport: () => 10,
    close: (changed) => {
      closed.called = true;
      closed.changed = changed;
    },
  });
  return {
    component,
    applyCalls,
    closed,
    render: (w = 120) => component.render(w),
    press: (data) => component.handleInput(data),
    tick: () => new Promise((r) => setTimeout(r, 0)),
  };
}

const cursorLine = (lines: string[]): string => lines.find((l) => /^> +\[/.test(l)) ?? "";
const lineFor = (lines: string[], name: string): string => lines.find((l) => l.includes(name)) ?? "";

describe("resource list TUI", () => {
  it("renders groups, checkboxes, scope, and path in global mode", () => {
    const rig = makeRig();
    const text = rig.render().join("\n");
    expect(rig.render()[0]).toContain("pi resources");
    expect(text).toContain("Extensions");
    expect(text).toContain("Skills");
    expect(text).toContain("[x] dummy.ts");
    expect(lineFor(rig.render(), "dummy.ts")).toContain("global");
    expect(lineFor(rig.render(), "dummy.ts")).toContain("/home/u/.pi/agent/extensions/dummy.ts");
    expect(lineFor(rig.render(), "proj.ts")).toContain("project");
    expect(rig.render()[rig.render().length - 1]).toContain("esc close");
  });

  it("space toggles the cursor row and writes the settings at once", async () => {
    const rig = makeRig();
    rig.press(" ");
    await rig.tick();
    expect(rig.applyCalls.length).toBe(1);
    expect(rig.applyCalls[0].global.extensions).toEqual(["-extensions/dummy.ts"]);
    expect(lineFor(rig.render(), "dummy.ts")).toContain("[ ]");
    rig.press(" ");
    await rig.tick();
    expect(rig.applyCalls[1].global.extensions).toEqual(["+extensions/dummy.ts"]);
    expect(lineFor(rig.render(), "dummy.ts")).toContain("[x]");
  });

  it("tab switches to project mode with the three-state cycle", async () => {
    const rig = makeRig();
    rig.press("\t");
    const text = rig.render().join("\n");
    expect(text).toContain("inherited global");
    // dummy.ts (global, enabled): inherit -> unload -> load -> inherit.
    rig.press(" ");
    await rig.tick();
    expect(rig.applyCalls[0].project.extensions).toEqual([
      "/home/u/.pi/agent/extensions/dummy.ts",
      "-/home/u/.pi/agent/extensions/dummy.ts",
    ]);
    expect(lineFor(rig.render(), "dummy.ts")).toContain("[-]");
    rig.press(" ");
    await rig.tick();
    expect(rig.applyCalls[1].project.extensions).toEqual([
      "/home/u/.pi/agent/extensions/dummy.ts",
      "+/home/u/.pi/agent/extensions/dummy.ts",
    ]);
    expect(lineFor(rig.render(), "dummy.ts")).toContain("[+]");
    rig.press(" ");
    await rig.tick();
    expect(rig.applyCalls[2].project.extensions).toEqual([]);
    expect(lineFor(rig.render(), "dummy.ts")).toContain("inherited global");
  });

  it("the project view toggles a project resource with a relative pattern", async () => {
    const rig = makeRig();
    rig.press("\t");
    // Item order: dummy.ts, tool.ts (package), proj.ts, my-skill.
    rig.press("\x1b[B");
    rig.press("\x1b[B");
    expect(cursorLine(rig.render())).toContain("proj.ts");
    rig.press(" ");
    await rig.tick();
    expect(rig.applyCalls[0].project.extensions).toContain("-extensions/proj.ts");
    expect(rig.applyCalls[0].global.extensions).toEqual([]);
  });

  it("package rows are read-only", async () => {
    const rig = makeRig();
    rig.press(" ");
    await rig.tick(); // dummy.ts
    rig.press("\x1b[B");
    expect(cursorLine(rig.render())).toContain("tool.ts");
    rig.press(" ");
    await rig.tick();
    expect(rig.applyCalls.length).toBe(1); // the package row was skipped
  });

  it("search filters rows and backspace clears", () => {
    const rig = makeRig();
    for (const c of "skill".split("")) rig.press(c);
    let text = rig.render().join("\n");
    expect(text).toContain("my-skill");
    expect(text).not.toContain("dummy.ts");
    for (let i = 0; i < 6; i++) rig.press("\x7f");
    text = rig.render().join("\n");
    expect(text).toContain("dummy.ts");
  });

  it("esc closes with the changed flag", async () => {
    const clean = makeRig();
    clean.press("\x1b");
    expect(clean.closed.called).toBe(true);
    expect(clean.closed.changed).toBe(false);

    const dirty = makeRig();
    dirty.press(" ");
    await dirty.tick();
    dirty.press("\x1b");
    expect(dirty.closed.changed).toBe(true);
  });

  it("a refused write rolls the state back and says why", async () => {
    const rig = makeRig(
      undefined,
      async () => ({ ok: false, error: "Project is not trusted; trust the project first." }),
    );
    rig.press(" ");
    await rig.tick();
    expect(lineFor(rig.render(), "dummy.ts")).toContain("[x]"); // rolled back
    expect(rig.render().join("\n")).toContain("Project is not trusted; trust the project first.");
    rig.press("\x1b");
    expect(rig.closed.changed).toBe(false);
  });

  it("tab in an untrusted project says why instead of switching", () => {
    const closed = { called: false } as { called: boolean };
    const component = createResourceToggleTui({
      tui: fakeTui,
      theme: fakeTheme,
      resources,
      settings: { global: emptyScopeArrays(), project: emptyScopeArrays() },
      machine,
      projectTrusted: false,
      apply: async (_prev, _next) => ({ ok: true }),
      viewport: () => 10,
      close: () => {
        closed.called = true;
      },
    });
    component.handleInput("\t");
    expect(component.render(120).join("\n")).toContain("Project mode unavailable");
  });
});
