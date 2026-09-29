/**
 * TUI tests for the resource list: drive the component with key events
 * against fake terminal and theme objects, asserting rendered lines and
 * the resulting state.
 */
import type { TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createResourceToggleTui } from "../../extensions/resource-toggle/tui.ts";
import { createResourcePickerTui } from "../../extensions/resource-toggle/picker.ts";
import type { MachineContext, ResourceInfo, SettingsState, ToggleOp } from "../../extensions/resource-toggle/lib/types.ts";
import { emptyScopeArrays } from "../../extensions/resource-toggle/lib/types.ts";
import type { WriteOutcome } from "../../extensions/resource-toggle/lib/writer.ts";

const fakeTheme = {
  fg: (_c: string, s: string) => s,
  bg: (_c: string, s: string) => s,
  bold: (s: string) => s,
} as unknown as Theme;
const fakeTui = { requestRender: () => {}, terminal: { rows: 40, columns: 120 } } as unknown as TUI;

// A theme that emits ANSI codes like pi's real theme, so styled rows carry
// escape codes in the rendered lines.
const ansiTheme = {
  fg: (_color: string, s: string) => `\x1b[36m${s}\x1b[39m`,
  bg: (_color: string, s: string) => s,
  bold: (s: string) => `\x1b[1m${s}\x1b[22m`,
} as unknown as Theme;

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

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

function makeRig(
  settings?: SettingsState,
  applyImpl?: (next: SettingsState) => Promise<WriteOutcome>,
  theme: Theme = fakeTheme,
): Rig {
  const applyCalls: SettingsState[] = [];
  const closed = { called: false } as { called: boolean; changed?: boolean };
  const component = createResourceToggleTui({
    tui: fakeTui,
    theme,
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

  it("clips styled rows by visible width, not by byte length", () => {
    // A raw byte slice of a styled row counts escape bytes as content and
    // eats the trailing visible characters on narrow terminals; the clip
    // must keep the full visible width and end with the ellipsis.
    const rig = makeRig(undefined, undefined, ansiTheme);
    const width = 40;
    const lines = rig.render(width);
    for (const line of lines) {
      expect(stripAnsi(line).length, `line overflows the grid: ${line}`).toBeLessThanOrEqual(width);
    }
    const visible = lines.map(stripAnsi);
    const cursorRow = visible.find((l) => /^> +\[/.test(l)) ?? "";
    const full = ">  [x] dummy.ts  global  /home/u/.pi/agent/extensions/dummy.ts";
    expect(cursorRow).toBe(`${full.slice(0, width - 3)}...`);
  });
});

// ---------------------------------------------------------------------------
// The resource picker
// ---------------------------------------------------------------------------

// A theme that marks dimmed text so tests can assert which rows are dimmed.
const dimTheme = {
  fg: (_color: string, s: string) => s,
  bg: (_color: string, s: string) => s,
  bold: (s: string) => s,
} as unknown as Theme;
const markedDimTheme = {
  fg: (color: string, s: string) => (color === "dim" ? `dim[${s}]` : s),
  bg: (_color: string, s: string) => s,
  bold: (s: string) => `B${s}`,
} as unknown as Theme;

const described = (info: ResourceInfo): ResourceInfo => ({ ...info, description: `${info.displayName} description.` });

// dummy.ts is disabled in global mode (the settings exclude it); the rest
// are enabled. proj.ts is a project resource.
const pickerResources: ResourceInfo[] = [
  described(
    res({
      path: "/home/u/.pi/agent/extensions/dummy.ts",
      displayName: "dummy.ts",
      enabled: false,
      ownEnabled: false,
    }),
  ),
  described(res({ path: "/pkg/ext/tool.ts", displayName: "tool.ts", origin: "package", source: "acme/pkg" })),
  described(res({ path: "/proj/.pi/extensions/proj.ts", displayName: "proj.ts", scope: "project" })),
  described(res({ path: "/home/u/.pi/agent/skills/my-skill/SKILL.md", displayName: "my-skill", type: "skills" })),
];

const pickerSettings = (): SettingsState => {
  const s = { global: emptyScopeArrays(), project: emptyScopeArrays() };
  s.global.extensions = ["-extensions/dummy.ts"]; // dummy.ts is disabled
  return s;
};

interface PickerRig {
  render: (w?: number) => string[];
  press: (data: string) => void;
  tick: () => Promise<void>;
  applyPickCalls: ResourceInfo[];
  closeCalls: ({ text: string } | null)[];
  setApplyPick: (impl: (resource: ResourceInfo) => Promise<{ ok: boolean; text: string }>) => void;
}

function makePickerRig(
  opts: {
    operation?: ToggleOp;
    initialMode?: "global" | "project";
    settings?: SettingsState;
    theme?: Theme;
    applyPick?: (resource: ResourceInfo) => Promise<{ ok: boolean; text: string }>;
  } = {},
): PickerRig {
  const applyPickCalls: ResourceInfo[] = [];
  const closeCalls: ({ text: string } | null)[] = [];
  let applyPickImpl =
    opts.applyPick ?? (async (resource: ResourceInfo) => ({ ok: true, text: `applied to ${resource.displayName}` }));
  const component = createResourcePickerTui({
    tui: fakeTui,
    theme: opts.theme ?? fakeTheme,
    operation: opts.operation ?? { op: "disable", mode: "global" },
    initialMode: opts.initialMode ?? "global",
    resources: pickerResources,
    settings: opts.settings ?? pickerSettings(),
    machine,
    projectTrusted: true,
    isSelf: () => false,
    applyPick: async (resource) => {
      applyPickCalls.push(resource);
      return applyPickImpl(resource);
    },
    viewport: () => 20,
    close: (result) => {
      closeCalls.push(result);
    },
  });
  return {
    render: (w = 120) => component.render(w),
    press: (data) => component.handleInput(data),
    tick: () => new Promise((r) => setTimeout(r, 0)),
    applyPickCalls,
    closeCalls,
    setApplyPick: (impl) => {
      applyPickImpl = impl;
    },
  };
}

describe("resource picker TUI", () => {
  it("renders every resource as a row: state mark, name, scope, path, and the description line", () => {
    const rig = makePickerRig({ theme: markedDimTheme });
    const text = rig.render().join("\n");
    expect(text).toContain("pick a resource to disable");
    expect(text).toContain("Extensions");
    expect(text).toContain("Skills");
    // Every row carries its dimmed description line.
    expect(text).toContain("dummy.ts description.");
    expect(text).toContain("my-skill description.");
    // Row content: disabled dummy, package tool, enabled proj, enabled skill.
    expect(text).toContain("Bdummy.ts  global  /home/u/.pi/agent/extensions/dummy.ts");
    expect(text).toContain("[x] tool.ts (package)  global  /pkg/ext/tool.ts");
    expect(text).toContain("[x] proj.ts  project  /proj/.pi/extensions/proj.ts");
    expect(text).toContain("[x] my-skill  global  /home/u/.pi/agent/skills/my-skill/SKILL.md");
    // No-op rows (a disabled row under /disable) and the package row are dimmed.
    expect(text).toContain("dim[[ ]] Bdummy.ts");
    expect(text).toContain("dim[   [x] tool.ts (package)");
    // Actionable rows are not dimmed.
    expect(text).not.toContain("dim[  [x] proj.ts");
  });

  it("typing filters by name, path, or kind", () => {
    const rig = makePickerRig();
    for (const c of "skill".split("")) rig.press(c);
    let text = rig.render().join("\n");
    expect(text).toContain("my-skill");
    expect(text).not.toContain("dummy.ts");
    for (let i = 0; i < 6; i++) rig.press("\x7f");
    text = rig.render().join("\n");
    expect(text).toContain("dummy.ts");
  });

  it("enter on an actionable row applies the active operation and closes with the report", async () => {
    const rig = makePickerRig();
    rig.press("\x1b[B"); // to tool.ts (package)
    rig.press("\x1b[B"); // to proj.ts
    rig.press("\r");
    await rig.tick();
    expect(rig.applyPickCalls.length).toBe(1);
    expect(rig.applyPickCalls[0]?.displayName).toBe("proj.ts");
    expect(rig.closeCalls.length).toBe(1);
    expect(rig.closeCalls[0]).toEqual({ text: "applied to proj.ts" });
  });

  it("a no-op pick says the resource is already in the target state and stays open", () => {
    const rig = makePickerRig();
    rig.press("\r"); // cursor on dummy.ts, already disabled under /disable
    expect(rig.applyPickCalls.length).toBe(0);
    expect(rig.closeCalls.length).toBe(0);
    expect(rig.render().join("\n")).toContain(`No change: "dummy.ts" is already disabled in global mode.`);
  });

  it("a failed write applies nothing, shows the error, and stays open", async () => {
    const rig = makePickerRig();
    rig.setApplyPick(async (resource) => ({ ok: false, text: `failed to write for ${resource.displayName}` }));
    rig.press("\x1b[B");
    rig.press("\x1b[B"); // to proj.ts
    rig.press("\r");
    await rig.tick();
    expect(rig.closeCalls.length).toBe(0);
    expect(rig.render().join("\n")).toContain("failed to write for proj.ts");
  });

  it("a package row pick is refused and stays open", () => {
    const rig = makePickerRig();
    rig.press("\x1b[B"); // to tool.ts (package)
    rig.press("\r");
    expect(rig.applyPickCalls.length).toBe(0);
    expect(rig.closeCalls.length).toBe(0);
    expect(rig.render().join("\n")).toContain(`Refused: "tool.ts" is a package resource; package rows are read-only.`);
  });

  it("tab switches the mode; project mode shows the inherited global marks", () => {
    const rig = makePickerRig();
    rig.press("\t");
    const text = rig.render().join("\n");
    // dummy.ts: no project override, inherited global (and disabled there).
    expect(text).toContain("[ ] dummy.ts  global  /home/u/.pi/agent/extensions/dummy.ts  inherited global");
    rig.press("\t");
    expect(rig.render().join("\n")).not.toContain("inherited global");
  });

  it("inherit picks are no-ops on rows without a project override", async () => {
    const settings = pickerSettings();
    // dummy.ts (a global resource) has a project load override, the same
    // entries the grid writes: the raw path plus the prefixed path.
    settings.project.extensions = ["/home/u/.pi/agent/extensions/dummy.ts", "+/home/u/.pi/agent/extensions/dummy.ts"];
    const rig = makePickerRig({ operation: { op: "inherit" }, initialMode: "project", settings, theme: markedDimTheme });
    const text = rig.render().join("\n");
    expect(text).toContain("pick a resource to inherit");
    // dummy.ts (with an override, shown as the [+] mark) is actionable;
    // proj.ts (without an override) is a no-op and dimmed.
    expect(text).toContain("[+] Bdummy.ts");
    expect(text).not.toContain("dim[[+] Bdummy.ts");
    expect(text).toContain("dim[   dim[[x]] proj.ts");
    rig.press("\r"); // cursor on dummy.ts
    await rig.tick();
    expect(rig.applyPickCalls.length).toBe(1);
    expect(rig.applyPickCalls[0]?.displayName).toBe("dummy.ts");
    expect(rig.closeCalls[0]).toEqual({ text: "applied to dummy.ts" });
  });

  it("esc closes with no change", () => {
    const rig = makePickerRig();
    rig.press("\x1b");
    expect(rig.closeCalls.length).toBe(1);
    expect(rig.closeCalls[0]).toBeNull();
  });

  it("clips styled rows to the terminal width", () => {
    const rig = makePickerRig({ theme: ansiTheme });
    const width = 40;
    for (const line of rig.render(width)) {
      expect(stripAnsi(line).length, `line overflows the picker: ${line}`).toBeLessThanOrEqual(width);
    }
  });
});

describe("grid description line", () => {
  it("grid rows show the dim description line beneath", () => {
    const component = createResourceToggleTui({
      tui: fakeTui,
      theme: fakeTheme,
      resources: pickerResources,
      settings: pickerSettings(),
      machine,
      projectTrusted: true,
      apply: async () => ({ ok: true }),
      viewport: () => 20,
      close: () => {},
    });
    const text = component.render(120).join("\n");
    expect(text).toContain("  dummy.ts description.");
    expect(text).toContain("  my-skill description.");
  });
});
