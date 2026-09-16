/**
 * The pure toggle state machine.
 *
 * Given the current settings arrays of both scopes, a resource reference,
 * and an operation, it returns the next settings arrays. It owns every
 * transition rule: same-scope toggle, Shadow entry creation and removal,
 * and pattern cleanup. The write semantics follow pi's own `pi config`
 * tool exactly, so the two tools stay interchangeable.
 *
 *   - Same-scope toggle (global mode, or a project resource in project
 *     mode): the array in the resource's own scope file is rewritten so it
 *     carries exactly one pattern entry for the resource, `+pattern` to
 *     force-include or `-pattern` to force-exclude.
 *   - Shadow (project mode, global resource): the project file gets a plain
 *     absolute path plus a matching `+`/`-` pattern for the same path. The
 *     plain path re-registers the resource at project scope, which wins the
 *     precedence deduplication; the global file is never touched, so a
 *     global disable entry stays in place.
 *   - Inherit: the project-side entries for the resource are removed.
 *
 * No I/O. No pi imports.
 */
import { basename, dirname, join, relative, sep } from "node:path";
import type {
  MachineContext,
  OverrideState,
  ResourceRef,
  ResourceType,
  Scope,
  SettingsState,
  ToggleOp,
} from "./types.ts";

const isPatternEntry = (entry: string): boolean =>
  entry.startsWith("!") || entry.startsWith("+") || entry.startsWith("-");

/** Strip the `+`, `-`, or `!` prefix of a settings entry. */
export function entryTarget(entry: string): string {
  return isPatternEntry(entry) ? entry.slice(1) : entry;
}

const toPosix = (p: string): string => p.split(sep).join("/");

export function defaultBaseDir(scope: Scope, ctx: MachineContext): string {
  return scope === "user" ? ctx.agentDir : join(ctx.cwd, ctx.configDir);
}

/** The pattern a same-scope settings entry uses for this resource. */
export function sameScopePattern(ref: ResourceRef, scope: Scope, ctx: MachineContext): string {
  const base = ref.baseDir ?? defaultBaseDir(scope, ctx);
  const rel = toPosix(relative(base, ref.path));
  return rel === "" ? "." : rel;
}

/**
 * Every spelling a project-file entry can use to target this resource: the
 * absolute path, the project-base-relative path, and the metadata base-dir
 * relative path when the resource has one. For a project resource this also
 * includes the same-scope pattern.
 */
export function projectTargets(ref: ResourceRef, ctx: MachineContext): Set<string> {
  const projectBase = defaultBaseDir("project", ctx);
  const targets = new Set<string>();
  const add = (s: string): void => {
    if (s && s !== "..") targets.add(s);
  };
  if (ref.scope === "project") add(sameScopePattern(ref, "project", ctx));
  add(ref.path);
  add(toPosix(relative(projectBase, ref.path)));
  if (ref.baseDir) add(toPosix(relative(ref.baseDir, ref.path)));
  return targets;
}

function cloneState(state: SettingsState): SettingsState {
  const cloneArrays = (a: SettingsState["global"]) => ({
    extensions: [...a.extensions],
    skills: [...a.skills],
    prompts: [...a.prompts],
    themes: [...a.themes],
  });
  return { global: cloneArrays(state.global), project: cloneArrays(state.project) };
}

/**
 * Apply one toggle operation and return the next settings arrays.
 * The input is never mutated.
 */
export function transition(prev: SettingsState, ref: ResourceRef, op: ToggleOp, ctx: MachineContext): SettingsState {
  const state = cloneState(prev);

  if (op.op === "inherit") {
    // Inherit is project mode only: clear the project-side entries.
    const isShadow = ref.scope === "user";
    const targets = projectTargets(ref, ctx);
    state.project[ref.type] = state.project[ref.type].filter((entry) => {
      if (isPatternEntry(entry) && targets.has(entryTarget(entry))) return false;
      if (isShadow && entry === ref.path) return false;
      return true;
    });
    return state;
  }

  const enabled = op.op === "enable";
  const isShadow = op.mode === "project" && ref.scope === "user";
  const inProjectFile = isShadow || ref.scope === "project";

  if (!isShadow) {
    // Same-scope toggle in the resource's own scope file.
    const scope: Scope = inProjectFile ? "project" : "user";
    const pattern = sameScopePattern(ref, scope, ctx);
    const bucket = scope === "user" ? state.global : state.project;
    const prefix = enabled ? "+" : "-";
    bucket[ref.type] = [...bucket[ref.type].filter((entry) => entryTarget(entry) !== pattern), `${prefix}${pattern}`];
    return state;
  }

  // Shadow: plain absolute path plus a matching pattern, in the project file.
  const targets = projectTargets(ref, ctx);
  const remaining = state.project[ref.type].filter((entry) => !(isPatternEntry(entry) && targets.has(entryTarget(entry))));
  const out = [...remaining];
  if (!out.includes(ref.path)) out.push(ref.path);
  out.push(`${enabled ? "+" : "-"}${ref.path}`);
  state.project[ref.type] = out;
  return state;
}

/**
 * The project-side override state of a resource: does the project file
 * carry a `+`/`-` pattern for it? Last matching entry wins, as in pi.
 */
export function projectOverrideState(state: SettingsState, ref: ResourceRef, ctx: MachineContext): OverrideState {
  const targets = projectTargets(ref, ctx);
  let override: OverrideState = "inherit";
  for (const entry of state.project[ref.type]) {
    if (!isPatternEntry(entry)) continue;
    if (!targets.has(entryTarget(entry))) continue;
    override = entry.startsWith("!") || entry.startsWith("-") ? "unload" : "load";
  }
  return override;
}

/**
 * The effective state of a resource under one override state. In inherit
 * the resource keeps its own-scope state.
 */
export function effectiveEnabled(override: OverrideState, ownEnabled: boolean): boolean {
  if (override === "load") return true;
  if (override === "unload") return false;
  return ownEnabled;
}

/**
 * One space press in project mode: the next state in the cycle. The cycle
 * always moves toward the opposite of the inherited state, so a second
 * press returns to inherit. Mirrors `pi config`.
 */
export function nextOverrideState(current: OverrideState, inheritedEnabled: boolean): OverrideState {
  if (current === "inherit") return inheritedEnabled ? "unload" : "load";
  if (current === "unload") return inheritedEnabled ? "load" : "inherit";
  return inheritedEnabled ? "inherit" : "unload";
}

/** The operation that realizes a target override state. */
export function overrideToOp(target: OverrideState): ToggleOp {
  if (target === "load") return { op: "enable", mode: "project" };
  if (target === "unload") return { op: "disable", mode: "project" };
  return { op: "inherit" };
}

/**
 * The base dir pi matches patterns against for this resource: the resource's
 * own base dir when it has one, else the scope default.
 */
function matchBaseDir(ref: ResourceRef, ctx: MachineContext): string {
  return ref.baseDir ?? defaultBaseDir(ref.scope, ctx);
}

/**
 * Mirror of pi's minimatch-based pattern matching: a pattern matches a
 * resource when it matches the base-relative path, the file base name, or
 * the absolute path; for a skill file the skill folder counts as well.
 * Exact (`+`/`-`) patterns match only the base-relative and absolute paths
 * (plus the skill folder), never the bare file name.
 */
function patternTargets(ref: ResourceRef, baseDir: string, exact: boolean): string[] {
  const targets = [toPosix(relative(baseDir, ref.path))];
  if (!exact) targets.push(basename(ref.path));
  targets.push(toPosix(ref.path));
  if (basename(ref.path) === "SKILL.md") {
    const parent = dirname(ref.path);
    targets.push(toPosix(relative(baseDir, parent)), toPosix(parent));
  }
  return targets;
}

/** `*` and `?` glob match (minimatch subset: no `**` recursion needed for resource patterns). */
function globMatch(pattern: string, text: string): boolean {
  if (!pattern.includes("*") && !pattern.includes("?")) return pattern === text;
  let regex = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") regex += "[^/]*";
    else if (c === "?") regex += "[^/]";
    else regex += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  try {
    return new RegExp(`^${regex}$`).test(text);
  } catch {
    return false;
  }
}

function exactMatches(pattern: string, ref: ResourceRef, ctx: MachineContext): boolean {
  const normalized = pattern.startsWith("./") ? pattern.slice(2) : toPosix(pattern);
  return patternTargets(ref, matchBaseDir(ref, ctx), true).includes(normalized);
}

function globPatternMatches(pattern: string, ref: ResourceRef, ctx: MachineContext): boolean {
  const normalized = toPosix(pattern);
  return patternTargets(ref, matchBaseDir(ref, ctx), false).some((target) => globMatch(normalized, target));
}

/**
 * The state of a resource in its own scope, derived from that scope's
 * settings arrays alone. Patterns apply in pi's order: `!` excludes first,
 * then `+` force-includes, then `-` force-excludes (a `-` always beats a `+`).
 */
export function scopeEnabled(state: SettingsState, ref: ResourceRef, ctx: MachineContext): boolean {
  const scope = ref.scope;
  const bucket = scope === "user" ? state.global : state.project;
  const entries = bucket[ref.type];
  const excludes: string[] = [];
  const forceIncludes: string[] = [];
  const forceExcludes: string[] = [];
  for (const entry of entries) {
    if (entry.startsWith("!")) excludes.push(entry.slice(1));
    else if (entry.startsWith("+")) forceIncludes.push(entry.slice(1));
    else if (entry.startsWith("-")) forceExcludes.push(entry.slice(1));
  }
  let enabled = true;
  if (excludes.some((p) => globPatternMatches(p, ref, ctx))) enabled = false;
  if (forceIncludes.some((p) => exactMatches(p, ref, ctx))) enabled = true;
  if (forceExcludes.some((p) => exactMatches(p, ref, ctx))) enabled = false;
  return enabled;
}

/**
 * Map a resource kind to its label, for messages and tables.
 */
export function resourceLabel(type: ResourceType): string {
  switch (type) {
    case "extensions":
      return "extension";
    case "skills":
      return "skill";
    case "prompts":
      return "prompt template";
    case "themes":
      return "theme";
  }
}
