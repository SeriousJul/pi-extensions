/**
 * Unit tests for the pure toggle state machine: asserted on the settings
 * arrays it produces and on the derived Toggle state, not on the steps it
 * takes.
 */
import { describe, expect, it } from "vitest";
import {
  effectiveEnabled,
  entryTarget,
  nextOverrideState,
  overrideToOp,
  projectOverrideState,
  scopeEnabled,
  sameScopePattern,
  transition,
} from "../../extensions/resource-toggle/lib/state-machine.ts";
import type { MachineContext, ResourceRef, SettingsState } from "../../extensions/resource-toggle/lib/types.ts";

const ctx: MachineContext = { cwd: "/proj", agentDir: "/home/u/.pi/agent", configDir: ".pi" };

const empty = (): SettingsState => ({
  global: { extensions: [], skills: [], prompts: [], themes: [] },
  project: { extensions: [], skills: [], prompts: [], themes: [] },
});

const ext = (name = "foo.ts"): ResourceRef => ({
  type: "extensions",
  path: `/home/u/.pi/agent/extensions/${name}`,
  scope: "user",
});

const projExt = (name = "bar.ts"): ResourceRef => ({
  type: "extensions",
  path: `/proj/.pi/extensions/${name}`,
  scope: "project",
});

describe("transition: same-scope toggle (global mode)", () => {
  it("disable writes one force-exclude pattern in the own scope file", () => {
    const next = transition(empty(), ext(), { op: "disable", mode: "global" }, ctx);
    expect(next.global.extensions).toEqual(["-extensions/foo.ts"]);
    expect(next.project.extensions).toEqual([]);
  });

  it("enable writes a force-include pattern", () => {
    const next = transition(empty(), ext(), { op: "enable", mode: "global" }, ctx);
    expect(next.global.extensions).toEqual(["+extensions/foo.ts"]);
  });

  it("enable replaces a prior disable entry in the same file", () => {
    const disabled = transition(empty(), ext(), { op: "disable", mode: "global" }, ctx);
    const next = transition(disabled, ext(), { op: "enable", mode: "global" }, ctx);
    expect(next.global.extensions).toEqual(["+extensions/foo.ts"]);
  });

  it("disable replaces a prior enable entry in the same file", () => {
    const enabled = transition(empty(), ext(), { op: "enable", mode: "global" }, ctx);
    const next = transition(enabled, ext(), { op: "disable", mode: "global" }, ctx);
    expect(next.global.extensions).toEqual(["-extensions/foo.ts"]);
  });

  it("is idempotent: toggling to the same state keeps exactly one entry", () => {
    const once = transition(empty(), ext(), { op: "disable", mode: "global" }, ctx);
    const twice = transition(once, ext(), { op: "disable", mode: "global" }, ctx);
    expect(twice.global.extensions).toEqual(["-extensions/foo.ts"]);
  });

  it("keeps unrelated entries in the array", () => {
    const prev = empty();
    prev.global.extensions.push("extensions/keep.ts", "-extensions/other.ts");
    const next = transition(prev, ext(), { op: "disable", mode: "global" }, ctx);
    expect(next.global.extensions).toEqual(["extensions/keep.ts", "-extensions/other.ts", "-extensions/foo.ts"]);
  });

  it("does not mutate the input", () => {
    const prev = empty();
    transition(prev, ext(), { op: "disable", mode: "global" }, ctx);
    expect(prev.global.extensions).toEqual([]);
  });

  it("a project resource toggles in the project file in global mode", () => {
    const next = transition(empty(), projExt(), { op: "disable", mode: "global" }, ctx);
    expect(next.project.extensions).toEqual(["-extensions/bar.ts"]);
    expect(next.global.extensions).toEqual([]);
  });

  it("a skill without a custom baseDir uses the agent dir base", () => {
    const skill: ResourceRef = { type: "skills", path: "/home/u/.pi/agent/skills/my-skill/SKILL.md", scope: "user" };
    const next = transition(empty(), skill, { op: "disable", mode: "global" }, ctx);
    expect(next.global.skills).toEqual(["-skills/my-skill/SKILL.md"]);
  });

  it("a skill with a custom baseDir (e.g. .agents) uses that base", () => {
    const skill: ResourceRef = {
      type: "skills",
      path: "/home/u/.agents/skills/my-skill/SKILL.md",
      scope: "user",
      baseDir: "/home/u/.agents",
    };
    const next = transition(empty(), skill, { op: "disable", mode: "global" }, ctx);
    expect(next.global.skills).toEqual(["-skills/my-skill/SKILL.md"]);
  });
});

describe("transition: shadow entries (project mode, global resource)", () => {
  it("disable writes a plain path plus a force-exclude pattern for the absolute path", () => {
    const next = transition(empty(), ext(), { op: "disable", mode: "project" }, ctx);
    expect(next.project.extensions).toEqual(["/home/u/.pi/agent/extensions/foo.ts", "-/home/u/.pi/agent/extensions/foo.ts"]);
    expect(next.global.extensions).toEqual([]);
  });

  it("enable writes the shadow with a force-include pattern", () => {
    const next = transition(empty(), ext(), { op: "enable", mode: "project" }, ctx);
    expect(next.project.extensions).toEqual(["/home/u/.pi/agent/extensions/foo.ts", "+/home/u/.pi/agent/extensions/foo.ts"]);
  });

  it("inherit removes the project-side entries, including the plain path", () => {
    const shadowed = transition(empty(), ext(), { op: "disable", mode: "project" }, ctx);
    const next = transition(shadowed, ext(), { op: "inherit" }, ctx);
    expect(next.project.extensions).toEqual([]);
  });

  it("keeps unrelated project entries when creating a shadow", () => {
    const prev = empty();
    prev.project.extensions.push("-extensions/bar.ts");
    const next = transition(prev, ext(), { op: "disable", mode: "project" }, ctx);
    expect(next.project.extensions).toEqual([
      "-extensions/bar.ts",
      "/home/u/.pi/agent/extensions/foo.ts",
      "-/home/u/.pi/agent/extensions/foo.ts",
    ]);
  });

  it("a prior disable in the global file stays untouched", () => {
    const prev = empty();
    prev.global.extensions.push("-extensions/foo.ts");
    const next = transition(prev, ext(), { op: "enable", mode: "project" }, ctx);
    expect(next.global.extensions).toEqual(["-extensions/foo.ts"]);
    expect(next.project.extensions).toEqual(["/home/u/.pi/agent/extensions/foo.ts", "+/home/u/.pi/agent/extensions/foo.ts"]);
  });

  it("replaces an existing shadow pattern in place", () => {
    const unloaded = transition(empty(), ext(), { op: "disable", mode: "project" }, ctx);
    const next = transition(unloaded, ext(), { op: "enable", mode: "project" }, ctx);
    expect(next.project.extensions).toEqual(["/home/u/.pi/agent/extensions/foo.ts", "+/home/u/.pi/agent/extensions/foo.ts"]);
  });
});

describe("transition: project mode, project resource", () => {
  it("disable writes a relative pattern in the project file", () => {
    const next = transition(empty(), projExt(), { op: "disable", mode: "project" }, ctx);
    expect(next.project.extensions).toEqual(["-extensions/bar.ts"]);
  });

  it("inherit clears the pattern entries for the resource", () => {
    const prev = empty();
    prev.project.extensions.push("-extensions/bar.ts");
    const next = transition(prev, projExt(), { op: "inherit" }, ctx);
    expect(next.project.extensions).toEqual([]);
  });
});

describe("scopeEnabled (derived own-scope state)", () => {
  it("defaults to enabled with no entries", () => {
    expect(scopeEnabled(empty(), ext(), ctx)).toBe(true);
  });

  it("a force-exclude disables", () => {
    const s = empty();
    s.global.extensions.push("-extensions/foo.ts");
    expect(scopeEnabled(s, ext(), ctx)).toBe(false);
  });

  it("a force-include enables over an exclude", () => {
    const s = empty();
    s.global.extensions.push("!extensions/*.ts", "+extensions/foo.ts");
    expect(scopeEnabled(s, ext(), ctx)).toBe(true);
  });

  it("a force-exclude beats a force-include for the same path", () => {
    const s = empty();
    s.global.extensions.push("+extensions/foo.ts", "-extensions/foo.ts");
    expect(scopeEnabled(s, ext(), ctx)).toBe(false);
  });

  it("an exclude glob disables matching paths", () => {
    const s = empty();
    s.global.extensions.push("!extensions/foo.*");
    expect(scopeEnabled(s, ext(), ctx)).toBe(false);
    expect(scopeEnabled(s, { ...ext(), path: "/home/u/.pi/agent/extensions/foo.js" }, ctx)).toBe(false);
  });

  it("absolute patterns match the resource", () => {
    const s = empty();
    s.global.extensions.push("-/home/u/.pi/agent/extensions/foo.ts");
    expect(scopeEnabled(s, ext(), ctx)).toBe(false);
  });

  it("a project resource reads the project file only", () => {
    const s = empty();
    s.global.extensions.push("-extensions/bar.ts");
    expect(scopeEnabled(s, projExt(), ctx)).toBe(true);
    s.project.extensions.push("-extensions/bar.ts");
    expect(scopeEnabled(s, projExt(), ctx)).toBe(false);
  });
});

describe("projectOverrideState and the cycle", () => {
  it("no project entries means inherit", () => {
    expect(projectOverrideState(empty(), ext(), ctx)).toBe("inherit");
  });

  it("a + shadow is load, a - shadow is unload", () => {
    const loaded = transition(empty(), ext(), { op: "enable", mode: "project" }, ctx);
    expect(projectOverrideState(loaded, ext(), ctx)).toBe("load");
    const unloaded = transition(empty(), ext(), { op: "disable", mode: "project" }, ctx);
    expect(projectOverrideState(unloaded, ext(), ctx)).toBe("unload");
  });

  it("the effective state follows the override", () => {
    expect(effectiveEnabled("inherit", true)).toBe(true);
    expect(effectiveEnabled("inherit", false)).toBe(false);
    expect(effectiveEnabled("load", false)).toBe(true);
    expect(effectiveEnabled("unload", true)).toBe(false);
  });

  it("the cycle moves away from inherit and returns to it", () => {
    // Inherited enabled: inherit -> unload -> load -> inherit.
    expect(nextOverrideState("inherit", true)).toBe("unload");
    expect(nextOverrideState("unload", true)).toBe("load");
    expect(nextOverrideState("load", true)).toBe("inherit");
    // Inherited disabled: inherit -> load -> unload -> inherit.
    expect(nextOverrideState("inherit", false)).toBe("load");
    expect(nextOverrideState("load", false)).toBe("unload");
    expect(nextOverrideState("unload", false)).toBe("inherit");
  });

  it("overrideToOp maps the cycle targets to operations", () => {
    expect(overrideToOp("load")).toEqual({ op: "enable", mode: "project" });
    expect(overrideToOp("unload")).toEqual({ op: "disable", mode: "project" });
    expect(overrideToOp("inherit")).toEqual({ op: "inherit" });
  });
});

describe("pattern helpers", () => {
  it("entryTarget strips one leading pattern character", () => {
    expect(entryTarget("+a")).toBe("a");
    expect(entryTarget("-a")).toBe("a");
    expect(entryTarget("!a")).toBe("a");
    expect(entryTarget("a")).toBe("a");
  });

  it("sameScopePattern is relative to the scope base dir", () => {
    expect(sameScopePattern(ext(), "user", ctx)).toBe("extensions/foo.ts");
    expect(sameScopePattern(projExt(), "project", ctx)).toBe("extensions/bar.ts");
  });
});
