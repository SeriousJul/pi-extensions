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
 * For a package resource the write is pi's own package filter (ADR 0029):
 * the package's entry in the packages array of the resource's own scope
 * file (global mode) or the project file (project mode) becomes object
 * form carrying a per-resource-type pattern array relative to the package
 * root. Disable writes `-pattern`, enable writes `+pattern`. A project
 * filter replaces, not merges, the global entry for the same package: pi's
 * dedupe keeps the winning entry whole. A packages entry that loses its
 * last filter collapses back to the plain source string, and an empty
 * per-type array is never written, because in pi an empty array disables
 * the whole type. A transition that touches a package resource also
 * removes the old no-op package-relative pattern the previous code wrote
 * into the settings resource arrays, so a harmed settings file heals
 * itself.
 *
 * No I/O. No pi imports.
 */
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type {
  MachineContext,
  OverrideState,
  PackageEntry,
  PackageFilter,
  ResourceRef,
  ResourceType,
  Scope,
  SettingsState,
  ToggleOp,
  WriteMode,
} from "./types.ts";
import { RESOURCE_TYPES } from "./types.ts";

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
  const cloneScope = (s: SettingsState["global"]) => ({
    extensions: [...s.extensions],
    skills: [...s.skills],
    prompts: [...s.prompts],
    themes: [...s.themes],
    packages: s.packages.map((entry) => (typeof entry === "string" ? entry : { ...entry })),
  });
  return { global: cloneScope(state.global), project: cloneScope(state.project) };
}

/** Thrown when a transition would disable the resource-toggle extension itself. */
export class SelfRefusalError extends Error {
  constructor() {
    super("Refused: resource-toggle will not disable itself; that would remove the toggle commands.");
    this.name = "SelfRefusalError";
  }
}

/**
 * Apply one toggle operation and return the next settings state.
 * The input is never mutated. A disable of the extension's own path
 * (ctx.selfPath) throws SelfRefusalError.
 */
export function transition(prev: SettingsState, ref: ResourceRef, op: ToggleOp, ctx: MachineContext): SettingsState {
  if (op.op !== "enable" && ctx.selfPath !== undefined && ref.path === ctx.selfPath) {
    throw new SelfRefusalError();
  }
  const state = cloneState(prev);

  if (ref.packageSource) {
    selfHealPackagePatterns(state, ref, ctx);
    return op.op === "inherit"
      ? inheritPackage(state, ref, ctx)
      : setPackageFilter(state, ref, op.op === "enable", op.mode, ctx);
  }

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

// ---------------------------------------------------------------------------
// Package resources: the packages-array filter (ADR 0029)
// ---------------------------------------------------------------------------

/**
 * The filter pattern pi uses for this package resource: the path relative
 * to the package root, exactly as `pi config` computes it.
 */
export function packagePattern(ref: ResourceRef): string {
  const baseDir = ref.baseDir ?? dirname(ref.path);
  const rel = toPosix(relative(baseDir, ref.path));
  return rel === "" ? "." : rel;
}

/** The absolute path a local package source resolves to, for comparison. */
function resolvedLocalSource(source: string, scope: Scope, ctx: MachineContext): string {
  return toPosix(resolve(defaultBaseDir(scope, ctx), source));
}

/** Mirrors pi: a source is local when it carries no npm/git/remote prefix. */
export function isLocalSource(source: string): boolean {
  return !/^(npm|git|github|http|https|ssh):/.test(source.trim());
}

/**
 * Whether two packages sources name the same package: an exact string
 * match, or, for two local sources, the same resolved path. Mirrors
 * `pi config`'s matching.
 */
export function packageSourceMatches(
  a: string,
  aScope: Scope,
  b: string,
  bScope: Scope,
  ctx: MachineContext,
): boolean {
  if (a === b) return true;
  if (!isLocalSource(a) || !isLocalSource(b)) return false;
  return resolvedLocalSource(a, aScope, ctx) === resolvedLocalSource(b, bScope, ctx);
}

/**
 * Find the packages entry that carries this package in one scope's array.
 * Local sources match by resolved path, as in pi.
 */
export function findPackageEntry(
  packages: readonly PackageEntry[],
  source: string,
  sourceScope: Scope,
  entryScope: Scope,
  ctx: MachineContext,
): number {
  return packages.findIndex((entry) =>
    packageSourceMatches(source, sourceScope, typeof entry === "string" ? entry : entry.source, entryScope, ctx),
  );
}

/** Whether one filter-array entry names this resource directly. */
function filterEntryTouches(entry: string, ref: ResourceRef, ctx: MachineContext): boolean {
  if (entry.startsWith("!")) return globPatternMatches(entry.slice(1), ref, ctx);
  if (entry.startsWith("+") || entry.startsWith("-")) return exactMatches(entry.slice(1), ref, ctx);
  return globPatternMatches(entry, ref, ctx);
}

/**
 * Whether the filter touches this resource at all. Any `+`/`-`/`!` pattern
 * that names the resource is a decision; a plain include is always a
 * decision, because in pi's loader it restricts the type to its matches.
 */
function filterTouchesResource(patterns: readonly string[], ref: ResourceRef, ctx: MachineContext): boolean {
  return patterns.some((p) => filterEntryTouches(p, ref, ctx)) || patterns.some((p) => !isPatternEntry(p));
}

/**
 * The state of one package resource under one packages entry, mirroring
 * pi's loader: an absent per-type key means the package default (enabled),
 * an empty array disables the whole type, and otherwise the patterns apply
 * in pi's order - plain includes restrict the type, `!` globs exclude,
 * `+` exact patterns force-include, and `-` exact patterns force-exclude
 * over everything - all relative to the package root.
 */
export function packageEntryEnabled(entry: PackageEntry, ref: ResourceRef, ctx: MachineContext): boolean {
  if (typeof entry === "string") return true;
  const patterns = entry[ref.type];
  if (patterns === undefined) return true;
  if (patterns.length === 0) return false;
  let enabled = true;
  const includes = patterns.filter((p) => !isPatternEntry(p));
  if (includes.length > 0 && !includes.some((p) => globPatternMatches(p, ref, ctx))) enabled = false;
  if (patterns.some((p) => p.startsWith("!") && globPatternMatches(p.slice(1), ref, ctx))) enabled = false;
  if (patterns.some((p) => p.startsWith("+") && exactMatches(p.slice(1), ref, ctx))) enabled = true;
  if (patterns.some((p) => p.startsWith("-") && exactMatches(p.slice(1), ref, ctx))) enabled = false;
  return enabled;
}

/**
 * Write the `+`/`-` filter for a package resource into the packages entry
 * of one scope file, mirroring `pi config`: a string entry becomes object
 * form, the resource's old pattern is replaced, an emptied per-type key is
 * dropped, and an entry with no filter left collapses back to the plain
 * source string. Returns the source the entry carries.
 */
function setPackageFilter(
  state: SettingsState,
  ref: ResourceRef,
  enabled: boolean,
  mode: WriteMode,
  ctx: MachineContext,
): SettingsState {
  const source = ref.packageSource!;
  // Same-scope rule as top-level resources: the entry lives in the file of
  // the resource's own scope in global mode, and in the project file in
  // project mode.
  const inProjectFile = mode === "project" || ref.scope === "project";
  const bucket = inProjectFile ? state.project : state.global;
  const pattern = packagePattern(ref);
  const index = findPackageEntry(bucket.packages, source, ref.scope, inProjectFile ? "project" : "user", ctx);
  if (index === -1) {
    // Not found: create the entry. A local source is rewritten relative to
    // the project base so the project file stays portable, as `pi config`
    // does.
    const entrySource =
      inProjectFile && ref.scope === "user" && isLocalSource(source)
        ? toPosix(relative(defaultBaseDir("project", ctx), resolvedLocalSource(source, "user", ctx))) || "."
        : source;
    const created: PackageFilter = { source: entrySource, [ref.type]: [`${enabled ? "+" : "-"}${pattern}`] };
    bucket.packages.push(created);
    return state;
  }
  const entry: PackageFilter = typeof bucket.packages[index] === "string"
    ? { source: bucket.packages[index] as string }
    : { ...bucket.packages[index] };
  const current = entry[ref.type] ?? [];
  const updated = current.filter((p) => entryTarget(p) !== pattern);
  updated.push(`${enabled ? "+" : "-"}${pattern}`);
  entry[ref.type] = updated;
  bucket.packages[index] = entry;
  return state;
}

/**
 * Clear the project override of a package resource: the resource's filter
 * patterns leave the project entry, an emptied per-type key is dropped, and
 * an entry with no filter left collapses back to the plain source string.
 */
function inheritPackage(state: SettingsState, ref: ResourceRef, ctx: MachineContext): SettingsState {
  const source = ref.packageSource!;
  const pattern = packagePattern(ref);
  const index = findPackageEntry(state.project.packages, source, ref.scope, "project", ctx);
  if (index === -1) return state;
  const entry: PackageFilter = typeof state.project.packages[index] === "string"
    ? { source: state.project.packages[index] as string }
    : { ...state.project.packages[index] };
  const current = entry[ref.type];
  if (current) {
    const updated = current.filter((p) => entryTarget(p) !== pattern);
    entry[ref.type] = updated.length > 0 ? updated : undefined;
  }
  const hasFilters = RESOURCE_TYPES.some((key) => entry[key] !== undefined);
  state.project.packages[index] = hasFilters ? entry : entry.source;
  return state;
}

/**
 * Self-heal: remove the old no-op package-relative pattern for this
 * resource from the settings resource arrays. The previous toggle code
 * wrote such patterns for package resources and pi ignores them there; the
 * project file may also carry an old shadow pair for the resource's
 * absolute path.
 */
function selfHealPackagePatterns(state: SettingsState, ref: ResourceRef, ctx: MachineContext): void {
  const pattern = packagePattern(ref);
  const removeGlobal = (entry: string): boolean =>
    !(isPatternEntry(entry) && entryTarget(entry) === pattern);
  state.global[ref.type] = state.global[ref.type].filter(removeGlobal);
  const targets = projectTargets(ref, ctx);
  const removeProject = (entry: string): boolean =>
    entry !== ref.path && !(isPatternEntry(entry) && targets.has(entryTarget(entry)));
  state.project[ref.type] = state.project[ref.type].filter(removeProject);
}

/**
 * The project-side override state of a resource: does the project file
 * carry a `+`/`-` pattern for it? Last matching entry wins, as in pi.
 */
export function projectOverrideState(state: SettingsState, ref: ResourceRef, ctx: MachineContext): OverrideState {
  if (ref.packageSource) return packageOverrideState(state, ref, ctx);
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
 * The project override of a package resource: the project file's packages
 * entry decides when it carries one for the package (pi's dedupe replaces
 * the global entry), otherwise the resource inherits the global state. A
 * string entry and an entry whose per-type filter never targets the
 * resource are both inherit.
 */
export function packageOverrideState(state: SettingsState, ref: ResourceRef, ctx: MachineContext): OverrideState {
  const index = findPackageEntry(state.project.packages, ref.packageSource!, ref.scope, "project", ctx);
  if (index === -1) return "inherit";
  const entry = state.project.packages[index];
  if (typeof entry === "string") return "inherit";
  const patterns = entry[ref.type];
  if (patterns === undefined) return "inherit";
  if (patterns.length === 0) return "unload";
  if (!filterTouchesResource(patterns, ref, ctx)) return "inherit";
  return packageEntryEnabled(entry, ref, ctx) ? "load" : "unload";
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
 * The state of a package resource read from one scope's packages array
 * alone, with the package default when the scope carries no entry for it.
 */
export function packageScopeEnabled(
  state: SettingsState,
  ref: ResourceRef,
  scope: Scope,
  ctx: MachineContext,
): boolean {
  const bucket = scope === "user" ? state.global : state.project;
  const index = findPackageEntry(bucket.packages, ref.packageSource!, ref.scope, scope, ctx);
  return index === -1 ? true : packageEntryEnabled(bucket.packages[index], ref, ctx);
}

/**
 * The own-scope state of a package resource. The packages entry of the
 * file the resource resolves from decides: the project entry when the
 * project file carries one (pi's dedupe replaces the global entry),
 * otherwise the global entry, and the package default when neither does.
 */
export function packageOwnEnabled(state: SettingsState, ref: ResourceRef, ctx: MachineContext): boolean {
  const projectIndex = findPackageEntry(state.project.packages, ref.packageSource!, ref.scope, "project", ctx);
  if (projectIndex !== -1) return packageEntryEnabled(state.project.packages[projectIndex], ref, ctx);
  return packageScopeEnabled(state, ref, "user", ctx);
}

/**
 * The state of a resource in its own scope, derived from that scope's
 * settings arrays alone. Patterns apply in pi's order: `!` excludes first,
 * then `+` force-includes, then `-` force-excludes (a `-` always beats a `+`).
 */
export function scopeEnabled(state: SettingsState, ref: ResourceRef, ctx: MachineContext): boolean {
  const scope = ref.scope;
  const bucket = scope === "user" ? state.global : state.project;
  if (ref.packageSource) return packageOwnEnabled(state, ref, ctx);
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
