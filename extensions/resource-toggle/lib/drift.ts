/**
 * The settings drift check (ADR 0047): a pure function over the raw
 * settings documents and the resolved resource catalog.
 *
 * Settings express intent: resource arrays, package filters, the
 * extension-named keys. When a line does nothing, the intent dies
 * silently - the user's model-router sat disabled under a populated
 * settings block until a hand audit named it. The check rides on the
 * same resolution the lists already perform and reports three v1
 * classes:
 *
 *   - Stale entry: an override pattern in a settings resource array, or
 *     any entry of a package filter, whose target matches no loaded
 *     resource and, where it resolves to a file path, names no file on
 *     disk.
 *   - Conflicting entries: two entries in one array with the same target
 *     and opposite polarity: one force-includes the resource the other
 *     force-excludes, so the array contradicts itself.
 *   - Configured while disabled: an extension disabled in the effective
 *     view while a top-level settings key equal to its name in camelCase
 *     (model-router to modelRouter) sits in a settings document. The key
 *     match is a name guess, not proof, so the finding is flagged
 *     possible: extensions that break the convention degrade to this
 *     soft finding, and a shared name that is not the extension's key
 *     stays a possible, never a hard error.
 *
 * A finding names its scope - global, project, or the package source -
 * so the fix lands in the right file. An untrusted project covers the
 * global scope only, matching what the rest of the resource view can
 * read. Findings are deduplicated and sorted by class, scope, then text,
 * so the notice and the tables are stable across runs and modes.
 *
 * No I/O but the injected path existence check (filesystem by default,
 * stubbed in tests). No pi imports.
 */
import { existsSync } from "node:fs";
import { basename, dirname } from "node:path";
import {
  defaultBaseDir,
  entryPath,
  entryTarget,
  isLocalSource,
  packageSourceMatches,
  patternTargetsResource,
  resolvedLocalSource,
} from "./state-machine.ts";
import type {
  DriftFinding,
  MachineContext,
  PackageEntry,
  RawSettingsDocument,
  ResourceInfo,
  ResourceType,
  Scope,
  ScopeState,
} from "./types.ts";
import { RESOURCE_TYPES } from "./types.ts";

/** The inputs of one drift computation, beyond the raw documents and the resolution. */
export interface DriftOptions {
  /** The machine context the patterns resolve against. */
  machine: MachineContext;
  /** An untrusted project covers the global scope only. */
  projectTrusted: boolean;
  /** Whether a path exists on disk. The filesystem by default; tests stub it. */
  pathExists?: (path: string) => boolean;
}

const isGlob = (text: string): boolean => text.includes("*") || text.includes("?");

const isPatternEntry = (entry: string): boolean =>
  entry.startsWith("!") || entry.startsWith("+") || entry.startsWith("-");

/** The exact target pi compares: a leading `./` is stripped, as in pi's loader. */
const exactTarget = (target: string): string => (target.startsWith("./") ? target.slice(2) : target);

const hasOwn = (doc: RawSettingsDocument, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(doc, key);

/**
 * The settings key an extension name maps to: model-router to
 * modelRouter, a single-word name to itself. A mismatch in any other
 * shape is not a finding.
 */
export function settingsKeyForExtension(name: string): string {
  const parts = name.split("-").filter(Boolean);
  if (parts.length === 0) return name;
  return parts.map((part, i) => (i === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1))).join("");
}

/**
 * Compute the drift findings of one session view. The raw documents
 * carry the top-level keys the soft class needs; the resolution carries
 * the catalog and the settings arrays the other two classes scan.
 */
export function computeDrift(
  raw: { global: RawSettingsDocument; project: RawSettingsDocument },
  resolved: { resources: ResourceInfo[]; settings: { global: ScopeState; project: ScopeState } },
  options: DriftOptions,
): DriftFinding[] {
  const { machine, projectTrusted } = options;
  const pathExists = options.pathExists ?? ((path) => existsSync(path));
  const findings: DriftFinding[] = [];
  const scopes: { scope: "global" | "project"; state: ScopeState }[] = [
    { scope: "global", state: resolved.settings.global },
  ];
  if (projectTrusted) {
    scopes.push({ scope: "project", state: resolved.settings.project });
  }
  for (const { scope, state } of scopes) {
    for (const type of RESOURCE_TYPES) {
      checkResourceArray(scope, state[type], type, findings, machine, pathExists, resolved.resources);
      checkPackageFilters(scope, state.packages, findings, machine, pathExists, resolved.resources);
    }
  }
  checkConfiguredDisabled(raw, projectTrusted, resolved.resources, findings);
  return dedupeAndSort(findings);
}

/**
 * The override patterns of one settings resource array. Plain entries
 * are not v1 drift: the class covers override patterns here and every
 * entry of a package filter. Pi applies the array's patterns to the
 * top-level resources only, each against its own base dir (the scope
 * default when it has none), so the candidates and their bases follow
 * pi: a pattern that names a `~/.agents` skill resolves against
 * `~/.agents`, and a package resource is never a candidate.
 */
function checkResourceArray(
  scope: "global" | "project",
  entries: string[],
  type: ResourceType,
  findings: DriftFinding[],
  machine: MachineContext,
  pathExists: (path: string) => boolean,
  resources: ResourceInfo[],
): void {
  const base = defaultBaseDir(scope === "global" ? "user" : "project", machine);
  const candidates = resources.filter((r) => r.type === type && r.origin === "top-level");
  const force = new Map<string, { plus: string[]; minus: string[] }>();
  for (const entry of entries) {
    if (!isPatternEntry(entry)) continue;
    const target = entryTarget(entry);
    const exact = entry.startsWith("+") || entry.startsWith("-");
    const matches = candidates.some((r) =>
      patternTargetsResource(
        target,
        { type: r.type, path: r.path, scope: r.scope },
        r.baseDir ?? defaultBaseDir(r.scope, machine),
        exact,
      ),
    );
    if (!matches && staleOnDisk(target, base, pathExists)) {
      findings.push({
        kind: "stale",
        scope,
        array: type,
        entries: [entry],
        possible: false,
        text: `stale entry: "${entry}" (${scope}, ${type}) matches no resource or file`,
      });
    }
    if (exact) {
      const key = exactTarget(target);
      const group = force.get(key) ?? { plus: [], minus: [] };
      (entry.startsWith("+") ? group.plus : group.minus).push(entry);
      force.set(key, group);
    }
  }
  for (const [target, group] of force) {
    if (group.plus.length === 0 || group.minus.length === 0) continue;
    findings.push({
      kind: "conflict",
      scope,
      array: type,
      entries: [group.plus[0], group.minus[0]],
      possible: false,
      text: `conflicting entries: "${group.plus[0]}" and "${group.minus[0]}" (${scope}, ${type}) target the same resource with opposite polarity`,
    });
  }
}

/**
 * Every entry of one packages array. A pattern is stale when it matches
 * no resource of the package and, for a local source, names no file in
 * the package root. A non-local source cannot be checked on disk, so a
 * non-matching pattern is stale on its own.
 */
function checkPackageFilters(
  scope: "global" | "project",
  packages: PackageEntry[],
  findings: DriftFinding[],
  machine: MachineContext,
  pathExists: (path: string) => boolean,
  resources: ResourceInfo[],
): void {
  for (const entry of packages) {
    if (typeof entry === "string") continue;
    const piScope: Scope = scope === "global" ? "user" : "project";
    const root = isLocalSource(entry.source) ? resolvedLocalSource(entry.source, piScope, machine) : undefined;
    for (const type of RESOURCE_TYPES) {
      const patterns = entry[type];
      if (patterns === undefined) continue;
      const members = resources.filter(
        (r) => r.type === type && r.origin === "package" && packageSourceMatches(entry.source, piScope, r.source, r.scope, machine),
      );
      const force = new Map<string, { plus: string[]; minus: string[] }>();
      for (const pattern of patterns) {
        const target = entryTarget(pattern);
        const exact = pattern.startsWith("+") || pattern.startsWith("-");
        const matches = members.some((r) => {
          const base = root ?? r.baseDir ?? defaultBaseDir("user", machine);
          return patternTargetsResource(target, { type: r.type, path: r.path, scope: r.scope }, base, exact);
        });
        const stale = !matches && (isGlob(target) || root === undefined || !pathExists(entryPath(target, root)));
        if (stale) {
          findings.push({
            kind: "stale",
            scope,
            array: type,
            packageSource: entry.source,
            entries: [pattern],
            possible: false,
            text: `stale entry: "${pattern}" (${scope}, packages "${entry.source}", ${type}) matches no resource or file in the package`,
          });
        }
        if (exact) {
          const key = exactTarget(target);
          const group = force.get(key) ?? { plus: [], minus: [] };
          (pattern.startsWith("+") ? group.plus : group.minus).push(pattern);
          force.set(key, group);
        }
      }
      for (const [target, group] of force) {
        if (group.plus.length === 0 || group.minus.length === 0) continue;
        findings.push({
          kind: "conflict",
          scope,
          array: type,
          packageSource: entry.source,
          entries: [group.plus[0], group.minus[0]],
          possible: false,
          text: `conflicting entries: "${group.plus[0]}" and "${group.minus[0]}" (${scope}, packages "${entry.source}", ${type}) target the same resource with opposite polarity`,
        });
      }
    }
  }
}

/**
 * The name of an extension for the camelCase key mapping: the file name
 * without its extension, or the folder name for an index file - the same
 * name the user reads in the lists.
 */
function extensionName(resource: ResourceInfo): string {
  const file = basename(resource.path);
  if (file === "index.ts" || file === "index.js") return basename(dirname(resource.path));
  return file.replace(/\.(ts|js|mts|cts)$/, "");
}

/**
 * The soft class: an extension disabled in the effective view while a
 * top-level settings key equal to its name in camelCase exists. An
 * untrusted project reads the global document only.
 */
function checkConfiguredDisabled(
  raw: { global: RawSettingsDocument; project: RawSettingsDocument },
  projectTrusted: boolean,
  resources: ResourceInfo[],
  findings: DriftFinding[],
): void {
  for (const resource of resources) {
    if (resource.type !== "extensions" || resource.enabled) continue;
    const name = extensionName(resource);
    const key = settingsKeyForExtension(name);
    const inGlobal = hasOwn(raw.global, key);
    const inProject = projectTrusted && hasOwn(raw.project, key);
    if (!inGlobal && !inProject) continue;
    const scope = inGlobal && inProject ? "global+project" : inGlobal ? "global" : "project";
    const scopeText = scope === "global+project" ? "global and project" : scope;
    findings.push({
      kind: "configured-disabled",
      scope,
      key,
      entries: [key],
      possible: true,
      text: `possible: extension "${name}" is disabled, but ${scopeText} settings carry the key "${key}"`,
    });
  }
}

/**
 * Where the class says to check: a non-glob target resolves to one path,
 * which must be missing for the entry to be stale. A glob names no single
 * file: the resource match is the whole check.
 */
function staleOnDisk(target: string, base: string, pathExists: (path: string) => boolean): boolean {
  if (isGlob(target)) return true;
  return !pathExists(entryPath(target, base));
}

const KIND_RANK: Record<DriftFinding["kind"], number> = { stale: 0, conflict: 1, "configured-disabled": 2 };

/**
 * Deduplicate and sort deterministically: by class, scope, then text.
 * The stable order keeps the notice and the tables identical across runs
 * and modes.
 */
export function dedupeAndSort(findings: DriftFinding[]): DriftFinding[] {
  const seen = new Set<string>();
  const unique: DriftFinding[] = [];
  for (const finding of findings) {
    const key =
      finding.kind === "configured-disabled"
        ? `configured-disabled|${finding.key}|${finding.scope}`
        : `${finding.kind}|${finding.scope}|${finding.packageSource ?? ""}|${finding.array ?? ""}|${[...finding.entries].sort().join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(finding);
  }
  return unique.sort(
    (a, b) =>
      KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
      (a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0) ||
      (a.text < b.text ? -1 : a.text > b.text ? 1 : 0),
  );
}

/**
 * The headless table section: a header and one line per finding, or an
 * empty string when the settings are clean.
 */
export function renderDriftSection(findings: DriftFinding[]): string {
  if (findings.length === 0) return "";
  const lines = [`drift (${findings.length})`];
  for (const finding of findings) lines.push(`  ${finding.text}`);
  return lines.join("\n");
}

/** The one session-start notice when the findings are non-empty. */
export function driftNoticeText(count: number): string {
  const noun = count === 1 ? "finding" : "findings";
  return `resource-toggle: ${count} settings drift ${noun} at session start; run /resources to see them`;
}
