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
  packageEntryEnabled,
  packageOverrideState,
  packagePattern,
  packageSourceMatches,
  projectOverrideState,
  scopeEnabled,
  sameScopePattern,
  SelfRefusalError,
  transition,
} from "../../extensions/resource-toggle/lib/state-machine.ts";
import type { MachineContext, PackageEntry, PackageFilter, ResourceRef, SettingsState } from "../../extensions/resource-toggle/lib/types.ts";
import { emptyScopeState } from "../../extensions/resource-toggle/lib/types.ts";

const ctx: MachineContext = { cwd: "/proj", agentDir: "/home/u/.pi/agent", configDir: ".pi" };

const empty = (): SettingsState => ({
  global: emptyScopeState(),
  project: emptyScopeState(),
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

// A package-bundled extension installed at /opt/pkgs/my-pkg: its state
// lives in the packages filter, never in a resource array.
const pkgExt = (name = "extensions/quota/index.ts"): ResourceRef => ({
  type: "extensions",
  path: `/opt/pkgs/my-pkg/${name}`,
  scope: "user",
  baseDir: "/opt/pkgs/my-pkg",
  packageSource: "git:github.com/acme/my-pkg",
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

describe("transition: package resources (packages-array filter)", () => {
  it("global disable turns the string entry into object form with a - pattern", () => {
    const prev = empty();
    prev.global.packages.push("git:github.com/acme/my-pkg");
    const next = transition(prev, pkgExt(), { op: "disable", mode: "global" }, ctx);
    expect(next.global.packages).toEqual([
      { source: "git:github.com/acme/my-pkg", extensions: ["-extensions/quota/index.ts"] },
    ]);
  });

  it("global enable swaps the - pattern for +", () => {
    const prev = empty();
    prev.global.packages.push({ source: "git:github.com/acme/my-pkg", extensions: ["-extensions/quota/index.ts"] });
    const next = transition(prev, pkgExt(), { op: "enable", mode: "global" }, ctx);
    expect(next.global.packages).toEqual([
      { source: "git:github.com/acme/my-pkg", extensions: ["+extensions/quota/index.ts"] },
    ]);
  });

  it("is idempotent: toggling to the same state keeps exactly one pattern", () => {
    const once = empty();
    once.global.packages.push("git:github.com/acme/my-pkg");
    const first = transition(once, pkgExt(), { op: "disable", mode: "global" }, ctx);
    const second = transition(first, pkgExt(), { op: "disable", mode: "global" }, ctx);
    expect(second.global.packages).toEqual([
      { source: "git:github.com/acme/my-pkg", extensions: ["-extensions/quota/index.ts"] },
    ]);
  });

  it("keeps unrelated package entries and unrelated filters in place", () => {
    const prev = empty();
    prev.global.packages.push(
      "npm:pi-web-access",
      { source: "git:github.com/acme/my-pkg", extensions: ["-extensions/other/index.ts"] },
    );
    const next = transition(prev, pkgExt(), { op: "disable", mode: "global" }, ctx);
    expect(next.global.packages).toEqual([
      "npm:pi-web-access",
      {
        source: "git:github.com/acme/my-pkg",
        extensions: ["-extensions/other/index.ts", "-extensions/quota/index.ts"],
      },
    ]);
  });

  it("an emptied filter collapses the entry back to the plain source string", () => {
    const prev = empty();
    prev.project.packages.push({ source: "git:github.com/acme/my-pkg", extensions: ["-extensions/quota/index.ts"] });
    const next = transition(prev, pkgExt(), { op: "inherit" }, ctx);
    expect(next.project.packages).toEqual(["git:github.com/acme/my-pkg"]);
  });

  it("inherit keeps the filters of other resources in the same entry", () => {
    const prev = empty();
    prev.project.packages.push({
      source: "git:github.com/acme/my-pkg",
      extensions: ["-extensions/quota/index.ts", "-extensions/other/index.ts"],
    });
    const next = transition(prev, pkgExt(), { op: "inherit" }, ctx);
    expect(next.project.packages).toEqual([
      { source: "git:github.com/acme/my-pkg", extensions: ["-extensions/other/index.ts"] },
    ]);
  });

  it("project mode load creates the project entry with a + pattern", () => {
    const prev = empty();
    prev.global.packages.push("git:github.com/acme/my-pkg");
    const next = transition(prev, pkgExt(), { op: "enable", mode: "project" }, ctx);
    expect(next.project.packages).toEqual([
      { source: "git:github.com/acme/my-pkg", extensions: ["+extensions/quota/index.ts"] },
    ]);
    expect(next.global.packages).toEqual(["git:github.com/acme/my-pkg"]);
  });

  it("project mode unload writes a - pattern into the project entry", () => {
    const prev = empty();
    prev.global.packages.push("git:github.com/acme/my-pkg");
    const next = transition(prev, pkgExt(), { op: "disable", mode: "project" }, ctx);
    expect(next.project.packages).toEqual([
      { source: "git:github.com/acme/my-pkg", extensions: ["-extensions/quota/index.ts"] },
    ]);
  });

  it("project mode on a globally disabled resource loads it for the project", () => {
    const prev = empty();
    prev.global.packages.push({ source: "git:github.com/acme/my-pkg", extensions: ["-extensions/quota/index.ts"] });
    const ref: ResourceRef = { ...pkgExt(), scope: "user" };
    const next = transition(prev, ref, { op: "enable", mode: "project" }, ctx);
    expect(next.project.packages).toEqual([
      { source: "git:github.com/acme/my-pkg", extensions: ["+extensions/quota/index.ts"] },
    ]);
    // Replace-not-merge: the project entry decides, the resource is enabled.
    const projectRef: ResourceRef = { ...pkgExt(), scope: "project" };
    expect(effectiveEnabled(projectOverrideState(next, projectRef, ctx), scopeEnabled(next, projectRef, ctx))).toBe(true);
  });

  it("a local source is rewritten relative to the project base in a created project entry", () => {
    const prev = empty();
    prev.global.packages.push("/home/u/src/pi-extensions");
    const ref: ResourceRef = {
      type: "extensions",
      path: "/home/u/src/pi-extensions/extensions/quota/index.ts",
      scope: "user",
      baseDir: "/home/u/src/pi-extensions",
      packageSource: "/home/u/src/pi-extensions",
    };
    const next = transition(prev, ref, { op: "disable", mode: "project" }, ctx);
    expect(next.project.packages).toEqual([
      { source: "../../home/u/src/pi-extensions", extensions: ["-extensions/quota/index.ts"] },
    ]);
  });

  it("self-heals an old no-op pattern from the global resource array", () => {
    const prev = empty();
    prev.global.packages.push("git:github.com/acme/my-pkg");
    prev.global.extensions.push("-extensions/quota/index.ts");
    const next = transition(prev, pkgExt(), { op: "disable", mode: "global" }, ctx);
    expect(next.global.extensions).toEqual([]);
    expect(next.global.packages).toEqual([
      { source: "git:github.com/acme/my-pkg", extensions: ["-extensions/quota/index.ts"] },
    ]);
  });

  it("self-heals an old shadow pair from the project resource array", () => {
    const prev = empty();
    prev.global.packages.push("git:github.com/acme/my-pkg");
    prev.project.extensions.push("/opt/pkgs/my-pkg/extensions/quota/index.ts", "-/opt/pkgs/my-pkg/extensions/quota/index.ts");
    const next = transition(prev, pkgExt(), { op: "disable", mode: "project" }, ctx);
    expect(next.project.extensions).toEqual([]);
  });

  it("does not write a package-relative pattern into a resource array", () => {
    const prev = empty();
    prev.global.packages.push("git:github.com/acme/my-pkg");
    const next = transition(prev, pkgExt(), { op: "disable", mode: "global" }, ctx);
    expect(next.global.extensions).toEqual([]);
    expect(next.project.extensions).toEqual([]);
  });

  it("never writes an empty per-type array", () => {
    const disabled = empty();
    disabled.global.packages.push("git:github.com/acme/my-pkg");
    const d = transition(disabled, pkgExt(), { op: "disable", mode: "global" }, ctx);
    const e = transition(d, pkgExt(), { op: "enable", mode: "global" }, ctx);
    for (const entry of [...d.global.packages, ...e.global.packages]) {
      if (typeof entry === "string") continue;
      for (const patterns of Object.values(entry)) {
        if (Array.isArray(patterns)) expect(patterns.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("derived state of package resources", () => {
  it("defaults to enabled with no packages entry", () => {
    expect(scopeEnabled(empty(), pkgExt(), ctx)).toBe(true);
  });

  it("patterns apply in pi's loader order", () => {
    const src = "git:github.com/acme/my-pkg";
    const withEntry = (extensions: string[]): SettingsState => ({
      global: { ...emptyScopeState(), packages: [{ source: src, extensions }] },
      project: emptyScopeState(),
    });
    const rel = "extensions/quota/index.ts";
    expect(scopeEnabled(withEntry([`-${rel}`]), pkgExt(), ctx)).toBe(false);
    expect(scopeEnabled(withEntry([`+${rel}`]), pkgExt(), ctx)).toBe(true);
    expect(scopeEnabled(withEntry([`!${rel}`]), pkgExt(), ctx)).toBe(false);
    // A force-include overrides a `!` exclusion.
    expect(scopeEnabled(withEntry([`!${rel}`, `+${rel}`]), pkgExt(), ctx)).toBe(true);
    // A force-exclude wins over everything, in any order.
    expect(scopeEnabled(withEntry([`-${rel}`, `+${rel}`]), pkgExt(), ctx)).toBe(false);
    expect(scopeEnabled(withEntry([`+${rel}`, `-${rel}`]), pkgExt(), ctx)).toBe(false);
    // A plain include restricts the type to its matches.
    expect(scopeEnabled(withEntry([rel]), pkgExt(), ctx)).toBe(true);
    expect(scopeEnabled(withEntry(["extensions/other/index.ts"]), pkgExt(), ctx)).toBe(false);
    // A filter of another package never applies.
    expect(scopeEnabled({ global: { ...emptyScopeState(), packages: [{ source: "npm:other", extensions: [`-${rel}`] }] }, project: emptyScopeState() }, pkgExt(), ctx)).toBe(true);
  });

  it("an empty per-type array disables the whole type; an absent key does not", () => {
    const src = "git:github.com/acme/my-pkg";
    const emptyArray = { global: { ...emptyScopeState(), packages: [{ source: src, extensions: [] }] }, project: emptyScopeState() };
    expect(scopeEnabled(emptyArray, pkgExt(), ctx)).toBe(false);
    const noKey = { global: { ...emptyScopeState(), packages: [{ source: src } as PackageFilter] }, project: emptyScopeState() };
    expect(scopeEnabled(noKey, pkgExt(), ctx)).toBe(true);
    const stringEntry = { global: { ...emptyScopeState(), packages: [src] }, project: emptyScopeState() };
    expect(scopeEnabled(stringEntry, pkgExt(), ctx)).toBe(true);
  });

  it("a filter for another resource does not change this one", () => {
    const s = empty();
    s.global.packages.push({ source: "git:github.com/acme/my-pkg", extensions: ["-extensions/other/index.ts"] });
    expect(scopeEnabled(s, pkgExt(), ctx)).toBe(true);
  });

  it("the project override comes from the project entry only", () => {
    const src = "git:github.com/acme/my-pkg";
    const projectState = (entry: PackageEntry) => ({ global: emptyScopeState(), project: { ...emptyScopeState(), packages: [entry] } });
    expect(packageOverrideState(empty(), pkgExt(), ctx)).toBe("inherit");
    expect(packageOverrideState(projectState(src), pkgExt(), ctx)).toBe("inherit");
    expect(packageOverrideState(projectState({ source: src, extensions: ["-extensions/quota/index.ts"] }), pkgExt(), ctx)).toBe("unload");
    expect(packageOverrideState(projectState({ source: src, extensions: ["+extensions/quota/index.ts"] }), pkgExt(), ctx)).toBe("load");
    expect(packageOverrideState(projectState({ source: src, extensions: ["-extensions/other/index.ts"] }), pkgExt(), ctx)).toBe("inherit");
    expect(packageOverrideState(projectState({ source: src, extensions: [] }), pkgExt(), ctx)).toBe("unload");
    // A project entry of another package is not an override.
    expect(packageOverrideState(projectState({ source: "npm:other", extensions: ["-extensions/quota/index.ts"] }), pkgExt(), ctx)).toBe("inherit");
  });

  it("replace-not-merge: a project entry with no filter for the resource enables it over a global -", () => {
    const s = empty();
    s.global.packages.push({ source: "git:github.com/acme/my-pkg", extensions: ["-extensions/quota/index.ts"] });
    s.project.packages.push({ source: "git:github.com/acme/my-pkg", extensions: ["+extensions/other/index.ts"] });
    const ref: ResourceRef = { ...pkgExt(), scope: "project" };
    expect(scopeEnabled(s, ref, ctx)).toBe(true);
    expect(packageOverrideState(s, ref, ctx)).toBe("inherit");
    expect(effectiveEnabled(packageOverrideState(s, ref, ctx), scopeEnabled(s, ref, ctx))).toBe(true);
  });

  it("a global - disables while no project entry exists", () => {
    const s = empty();
    s.global.packages.push({ source: "git:github.com/acme/my-pkg", extensions: ["-extensions/quota/index.ts"] });
    const ref: ResourceRef = pkgExt();
    expect(scopeEnabled(s, ref, ctx)).toBe(false);
    expect(packageOverrideState(s, ref, ctx)).toBe("inherit");
    expect(effectiveEnabled(packageOverrideState(s, ref, ctx), scopeEnabled(s, ref, ctx))).toBe(false);
  });

  it("packageEntryEnabled mirrors the loader for a single entry", () => {
    expect(packageEntryEnabled("git:github.com/acme/my-pkg", pkgExt(), ctx)).toBe(true);
    expect(packageEntryEnabled({ source: "x", extensions: ["-extensions/quota/index.ts"] }, pkgExt(), ctx)).toBe(false);
    expect(packageEntryEnabled({ source: "x", extensions: ["+extensions/quota/index.ts"] }, pkgExt(), ctx)).toBe(true);
    expect(packageEntryEnabled({ source: "x", extensions: [] }, pkgExt(), ctx)).toBe(false);
    expect(packageEntryEnabled({ source: "x" }, pkgExt(), ctx)).toBe(true);
  });
});

describe("package source matching", () => {
  it("packagePattern is relative to the package root", () => {
    expect(packagePattern(pkgExt())).toBe("extensions/quota/index.ts");
  });

  it("exact strings match; local sources match by resolved path", () => {
    expect(packageSourceMatches("git:github.com/acme/my-pkg", "user", "git:github.com/acme/my-pkg", "project", ctx)).toBe(true);
    expect(packageSourceMatches("git:github.com/acme/my-pkg", "user", "npm:acme/my-pkg", "project", ctx)).toBe(false);
    expect(packageSourceMatches("/home/u/src/pi-extensions", "user", "/home/u/src/pi-extensions", "project", ctx)).toBe(true);
    expect(packageSourceMatches("../src/pi-extensions", "user", "../../../../home/u/.pi/src/pi-extensions", "project", ctx)).toBe(true);
    expect(packageSourceMatches("../src/pi-extensions", "user", "../../../home/u/src/pi-extensions", "project", ctx)).toBe(false);
  });

  it("a top-level ref is untouched by the package paths", () => {
    const prev = empty();
    prev.global.extensions.push("-extensions/dummy.ts");
    const next = transition(prev, ext(), { op: "disable", mode: "global" }, ctx);
    expect(next.global.extensions).toEqual(["-extensions/dummy.ts", "-extensions/foo.ts"]);
    expect(next.global.packages).toEqual([]);
  });
});

describe("self-guard", () => {
  const withSelf = (path: string): MachineContext => ({ ...ctx, selfPath: path });

  it("refuses to disable the resource-toggle itself, top-level or package", () => {
    const top: ResourceRef = { type: "extensions", path: "/opt/pkgs/my-pkg/extensions/resource-toggle/index.ts", scope: "user" };
    const pkg: ResourceRef = {
      type: "extensions",
      path: "/opt/pkgs/my-pkg/extensions/resource-toggle/index.ts",
      scope: "user",
      baseDir: "/opt/pkgs/my-pkg",
      packageSource: "git:github.com/SeriousJul/pi-extensions",
    };
    for (const ref of [top, pkg]) {
      expect(() => transition(empty(), ref, { op: "disable", mode: "global" }, withSelf(ref.path))).toThrow(SelfRefusalError);
      expect(() => transition(empty(), ref, { op: "inherit" }, withSelf(ref.path))).toThrow(SelfRefusalError);
      expect(() => transition(empty(), ref, { op: "enable", mode: "global" }, withSelf(ref.path))).not.toThrow();
    }
  });

  it("does not touch settings on refusal", () => {
    const prev = empty();
    prev.global.packages.push("git:github.com/SeriousJul/pi-extensions");
    const ref: ResourceRef = {
      type: "extensions",
      path: "/opt/pkgs/my-pkg/extensions/resource-toggle/index.ts",
      scope: "user",
      baseDir: "/opt/pkgs/my-pkg",
      packageSource: "git:github.com/SeriousJul/pi-extensions",
    };
    expect(() => transition(prev, ref, { op: "disable", mode: "global" }, withSelf(ref.path))).toThrow(SelfRefusalError);
    expect(prev.global.packages).toEqual(["git:github.com/SeriousJul/pi-extensions"]);
  });

  it("allows other resources when selfPath is set, and everything when it is absent", () => {
    const other = ext();
    expect(() => transition(empty(), other, { op: "disable", mode: "global" }, withSelf("/elsewhere/index.ts"))).not.toThrow();
    const self: ResourceRef = { type: "extensions", path: "/elsewhere/index.ts", scope: "user" };
    expect(() => transition(empty(), self, { op: "disable", mode: "global" }, ctx)).not.toThrow();
  });
});
