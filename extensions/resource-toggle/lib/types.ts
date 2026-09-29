/**
 * Shared types for the resource-toggle extension.
 */

/** The four resource kinds pi loads from disk. */
export type ResourceType = "extensions" | "skills" | "prompts" | "themes";

export const RESOURCE_TYPES: readonly ResourceType[] = ["extensions", "skills", "prompts", "themes"];

/** pi's source scope: where a resource lives. "user" is the global scope. */
export type Scope = "user" | "project";

/** The write mode of a toggle: which view the user works in. */
export type WriteMode = "global" | "project";

/** The four resource arrays of one settings file. */
export interface ScopeArrays {
  extensions: string[];
  skills: string[];
  prompts: string[];
  themes: string[];
}

/** An object-form packages entry: a package source plus per-resource-type filter patterns. */
export interface PackageFilter {
  source: string;
  /** Patterns for the package's extensions, relative to the package root. */
  extensions?: string[];
  /** Patterns for the package's skills, relative to the package root. */
  skills?: string[];
  /** Patterns for the package's prompt templates, relative to the package root. */
  prompts?: string[];
  /** Patterns for the package's themes, relative to the package root. */
  themes?: string[];
}

/** One packages-array entry: a plain source string (no filter) or object form. */
export type PackageEntry = string | PackageFilter;

/** The toggle-relevant state of one settings file. */
export interface ScopeState extends ScopeArrays {
  /** The packages entries (package sources, optionally with filters). */
  packages: PackageEntry[];
}

export function emptyScopeState(): ScopeState {
  return { extensions: [], skills: [], prompts: [], themes: [], packages: [] };
}

/** The toggle-relevant state of both settings files. */
export interface SettingsState {
  global: ScopeState;
  project: ScopeState;
}

/** A top-level resource the state machine operates on. */
export interface ResourceRef {
  type: ResourceType;
  /** Absolute path of the resource file. */
  path: string;
  /** The scope the resource lives in. */
  scope: Scope;
  /** Absolute base directory the resource resolves patterns against (may differ from the default). */
  baseDir?: string;
  /**
   * For a package resource: the packages source that carries it, as written
   * in the settings. It locates the packages entry the toggle manages.
   * Absent for a top-level resource.
   */
  packageSource?: string;
}

/** One toggle operation. "inherit" is project mode only. */
export type ToggleOp =
  | { op: "enable"; mode: WriteMode }
  | { op: "disable"; mode: WriteMode }
  | { op: "inherit" };

/** The project-side state of a resource: does the project file carry an override? */
export type OverrideState = "inherit" | "load" | "unload";

/** Paths the state machine needs to compute patterns. */
export interface MachineContext {
  cwd: string;
  agentDir: string;
  /** The project config directory name (".pi" by default). */
  configDir: string;
  /**
   * The loaded path of the resource-toggle extension itself. A transition
   * that would disable it is refused; absent in contexts without a
   * resource-toggle (then nothing is refused).
   */
  selfPath?: string;
}

/** One loadable resource with its derived state, as shown in lists. */
export interface ResourceInfo {
  type: ResourceType;
  /** Absolute path of the resource file. */
  path: string;
  /** The short name users type: file name (extension, prompt, theme) or frontmatter name (skill). */
  displayName: string;
  /** The scope the resource lives in. */
  scope: Scope;
  origin: "package" | "top-level";
  /** Package source, "auto" (auto-discovered), or "local" (settings entry). */
  source: string;
  baseDir?: string;
  /** Effective state: what pi loads right now, project overrides applied. */
  enabled: boolean;
  /** State in the resource's own scope: the global view of the list. */
  ownEnabled: boolean;
}

/** The read-only resolution of every loadable resource. */
export interface ResolvedResources {
  /** Canonical list: every resource, own-scope identity, effective state. */
  resources: ResourceInfo[];
  /** The raw settings arrays of both scopes. */
  settings: SettingsState;
}
