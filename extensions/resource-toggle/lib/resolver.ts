/**
 * The read-only resource resolver.
 *
 * Wraps pi's native package manager resolution and the settings read to
 * produce the unified resource list with the derived Toggle state per
 * resource. It never installs missing packages: resolution runs with a skip
 * callback, so a stale package entry stays a pure read.
 */
import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import {
  type ResolvedPaths,
  type ResolvedResource,
  CONFIG_DIR_NAME,
  DefaultPackageManager,
  SettingsManager,
  parseFrontmatter,
} from "@earendil-works/pi-coding-agent";
import type { MachineContext, ResolvedResources, ResourceInfo, ResourceRef, ScopeArrays, ResourceType } from "./types.ts";
import { scopeEnabled } from "./state-machine.ts";

const SKIP_MISSING = async (): Promise<"skip"> => "skip";

export interface ResolveOptions {
  cwd: string;
  agentDir: string;
  projectTrusted: boolean;
  /**
   * This extension's own file. It is listed as a row even when the resource
   * resolver does not enumerate it (for example when the extension was
   * loaded from the command line), so the self-guard has a row to find.
   */
  selfPath?: string;
}

/** The toggle name for this extension's own file: its folder for an index file. */
function selfDisplayName(selfPath: string): string {
  const file = basename(selfPath);
  if (file === "index.ts" || file === "index.js") return basename(dirname(selfPath));
  return file.replace(/\.(ts|js|mts|cts)$/, "");
}

function pickArrays(settings: {
  extensions?: string[];
  skills?: string[];
  prompts?: string[];
  themes?: string[];
}): ScopeArrays {
  return {
    extensions: [...(settings.extensions ?? [])],
    skills: [...(settings.skills ?? [])],
    prompts: [...(settings.prompts ?? [])],
    themes: [...(settings.themes ?? [])],
  };
}

/**
 * The display name of a resolved resource: the file base name for an
 * extension, prompt template, or theme, and the frontmatter name for a
 * skill. Extensions one folder out of the extensions directory keep their
 * folder, as in `pi config`.
 */
export function displayNameFor(type: ResourceType, path: string): string {
  const file = basename(path);
  const parent = basename(dirname(path));
  if (type === "extensions" && parent !== "extensions") {
    return `${parent}/${file}`;
  }
  if (type === "skills") {
    if (file !== "SKILL.md") return file;
    try {
      const { frontmatter } = parseFrontmatter(readFileSync(path, "utf8"));
      const name = frontmatter?.name;
      if (typeof name === "string" && name.trim()) return name.trim();
    } catch {
      // Unreadable frontmatter falls through to the folder name.
    }
    return parent;
  }
  return file;
}

function toList(paths: ResolvedPaths): ResourceInfo[] {
  const out: ResourceInfo[] = [];
  const add = (type: ResourceType, res: ResolvedResource): void => {
    out.push({
      type,
      path: res.path,
      displayName: displayNameFor(type, res.path),
      scope: res.metadata.scope === "project" ? "project" : "user",
      origin: res.metadata.origin,
      source: res.metadata.source,
      baseDir: res.metadata.baseDir,
      enabled: res.enabled,
      ownEnabled: res.enabled,
    });
  };
  for (const res of paths.extensions) add("extensions", res);
  for (const res of paths.skills) add("skills", res);
  for (const res of paths.prompts) add("prompts", res);
  for (const res of paths.themes) add("themes", res);
  return out;
}

/**
 * Resolve every loadable resource. The global view comes from an untrusted
 * manager (user scope only, no project shadowing); the effective view from
 * the trusted manager (project overrides applied). The merged list keeps
 * the own-scope identity of each resource and the effective state.
 */
export async function resolveResources(options: ResolveOptions): Promise<ResolvedResources> {
  const { cwd, agentDir, projectTrusted, selfPath } = options;
  const globalManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  const trustedManager = SettingsManager.create(cwd, agentDir, { projectTrusted });

  const globalPaths = await new DefaultPackageManager({ cwd, agentDir, settingsManager: globalManager }).resolve(SKIP_MISSING);
  const effectivePaths = projectTrusted
    ? await new DefaultPackageManager({ cwd, agentDir, settingsManager: trustedManager }).resolve(SKIP_MISSING)
    : globalPaths;

  const globalList = new Map<string, ResourceInfo>();
  for (const info of toList(globalPaths)) globalList.set(`${info.type}:${info.path}`, info);

  const merged: ResourceInfo[] = [];
  const seen = new Set<string>();
  for (const info of toList(effectivePaths)) {
    const key = `${info.type}:${info.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // A shadowed global resource resolves at project scope in the effective
    // view; keep its own-scope identity for the global view.
    const own = globalList.get(key);
    merged.push(own ? { ...own, enabled: info.enabled } : info);
  }
  // Resources the effective view did not list (untrusted project).
  for (const info of globalList.values()) {
    const key = `${info.type}:${info.path}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(info);
    }
  }
  if (selfPath) {
    const alreadyListed = merged.some((info) => info.path === selfPath);
    if (!alreadyListed) {
      const globals = pickArrays(globalManager.getGlobalSettings());
      const info: ResourceInfo = {
        type: "extensions",
        path: selfPath,
        displayName: selfDisplayName(selfPath),
        scope: "user",
        origin: "top-level",
        source: "cli",
        baseDir: agentDir,
        enabled: false,
        ownEnabled: false,
      };
      const ref: ResourceRef = { type: "extensions", path: selfPath, scope: "user", baseDir: agentDir };
      info.enabled = scopeEnabled({ global: globals, project: emptyProject() }, ref, machineContextFor(cwd, agentDir));
      info.ownEnabled = info.enabled;
      merged.push(info);
    }
  }

  merged.sort((a, b) => a.displayName.localeCompare(b.displayName) || a.path.localeCompare(b.path));

  return {
    resources: merged,
    settings: {
      global: pickArrays(trustedManager.getGlobalSettings()),
      project: pickArrays(trustedManager.getProjectSettings()),
    },
  };
}

const emptyProject = (): ScopeArrays => ({ extensions: [], skills: [], prompts: [], themes: [] });

/** The machine context for the session's paths. */
export function machineContextFor(cwd: string, agentDir: string): MachineContext {
  return { cwd, agentDir, configDir: CONFIG_DIR_NAME };
}
