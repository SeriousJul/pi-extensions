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

export function emptyScopeArrays(): ScopeArrays {
  return { extensions: [], skills: [], prompts: [], themes: [] };
}

/** The toggle-relevant state of both settings files. */
export interface SettingsState {
  global: ScopeArrays;
  project: ScopeArrays;
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
