/**
 * The interactive resource list, opened by /resources in TUI mode.
 *
 * Mirrors `pi config`: it starts in global mode, Tab switches to project
 * mode, resources are grouped by type with a search filter. Global mode
 * shows a two-state checkbox per resource; project mode shows inherited
 * global resources dimmed, and space cycles inherit, load, unload. Every
 * toggle writes the settings at once; one reload runs on close if anything
 * changed. Package resources appear dimmed and read-only.
 */
import { matchesKey } from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  effectiveEnabled,
  nextOverrideState,
  overrideToOp,
  projectOverrideState,
  resourceLabel,
  scopeEnabled,
  transition,
} from "./lib/state-machine.ts";
import type { ResourceInfo, ResourceRef, ResourceType, SettingsState, ToggleOp } from "./lib/types.ts";
import type { WriteOutcome } from "./lib/writer.ts";
import { RESOURCE_TYPES } from "./lib/types.ts";

const TYPE_LABELS: Record<ResourceType, string> = {
  extensions: "Extensions",
  skills: "Skills",
  prompts: "Prompts",
  themes: "Themes",
};

export interface ResourceTuiDeps {
  tui: TUI;
  theme: Theme;
  /** Every loadable resource, canonical own-scope identity. */
  resources: ResourceInfo[];
  /** The settings arrays; the component keeps its own copy. */
  settings: SettingsState;
  machine: { cwd: string; agentDir: string; configDir: string };
  /** Whether the project view is available (project trusted). */
  projectTrusted: boolean;
  /** Writes the prev-to-next diff into the settings files; resolves with the outcome. */
  apply: (prev: SettingsState, next: SettingsState) => Promise<WriteOutcome>;
  /** How many item rows fit at the current terminal size. */
  viewport: () => number;
  /** Leaves the list. Runs after the list closes. */
  close: (changed: boolean) => void;
}

interface Row {
  resource: ResourceInfo;
  enabled: boolean;
  override: "inherit" | "load" | "unload";
  inherited: boolean;
  packageRow: boolean;
}

const refOf = (r: ResourceInfo): ResourceRef => ({
  type: r.type,
  path: r.path,
  scope: r.scope,
  baseDir: r.baseDir,
});

export function createResourceToggleTui(deps: ResourceTuiDeps) {
  const { theme, tui } = deps;

  let mode: "global" | "project" = "global";
  let settings: SettingsState = deps.settings;
  let search = "";
  let cursor = 0;
  let top = 0;
  let changed = false;
  let busy = false;
  let writeError: string | undefined;

  const rows: Row[] = [];
  let visible: Row[] = [];

  const rebuild = (): void => {
    rows.length = 0;
    for (const type of RESOURCE_TYPES) {
      const group = deps.resources
        .filter((r) => r.type === type)
        .sort((a, b) => (a.scope === b.scope ? a.displayName.localeCompare(b.displayName) : a.scope === "user" ? -1 : 1));
      for (const resource of group) {
        const ref = refOf(resource);
        const own = scopeEnabled(settings, ref, deps.machine);
        const override = projectOverrideState(settings, ref, deps.machine);
        const enabled = mode === "global" ? own : effectiveEnabled(override, own);
        rows.push({
          resource,
          enabled,
          override: mode === "global" ? "inherit" : override,
          inherited: mode === "project" && resource.scope === "user" && override === "inherit",
          packageRow: resource.origin === "package",
        });
      }
    }
    applyFilter();
  };

  const applyFilter = (): void => {
    const query = search.trim().toLowerCase();
    visible = query
      ? rows.filter(
          (row) =>
            row.resource.displayName.toLowerCase().includes(query) ||
            row.resource.path.toLowerCase().includes(query) ||
            resourceLabel(row.resource.type).toLowerCase().includes(query),
        )
      : [...rows];
    if (cursor >= visible.length) cursor = Math.max(0, visible.length - 1);
  };

  const switchMode = (): void => {
    if (!deps.projectTrusted) {
      writeError = "Project mode unavailable: the project is not trusted.";
      tui.requestRender();
      return;
    }
    mode = mode === "global" ? "project" : "global";
    writeError = undefined;
    rebuild();
    tui.requestRender();
  };

  const toggle = (): void => {
    const row = visible[cursor];
    if (!row || row.packageRow || busy) return;
    busy = true;
    writeError = undefined;
    const ref = refOf(row.resource);
    let next: SettingsState;
    if (mode === "global") {
      const op: ToggleOp = row.enabled ? { op: "disable", mode: "global" } : { op: "enable", mode: "global" };
      next = transition(settings, ref, op, deps.machine);
    } else {
      const own = scopeEnabled(settings, ref, deps.machine);
      const inheritedEnabled = row.resource.scope === "user" ? own : true;
      const target = nextOverrideState(row.override, inheritedEnabled);
      next = transition(settings, ref, overrideToOp(target), deps.machine);
    }
    const prev = settings;
    settings = next;
    rebuild();
    void deps
      .apply(prev, next)
      .then((outcome) => {
        busy = false;
        if (!outcome.ok) {
          settings = prev;
          writeError = outcome.error ?? "Settings write failed.";
        } else {
          changed = true;
        }
        rebuild();
        tui.requestRender();
      })
      .catch((error: unknown) => {
        busy = false;
        settings = prev;
        writeError = error instanceof Error ? error.message : String(error);
        rebuild();
        tui.requestRender();
      });
  };

  const move = (delta: number): void => {
    if (visible.length === 0) return;
    cursor = Math.max(0, Math.min(visible.length - 1, cursor + delta));
  };

  const renderCheckbox = (row: Row): string => {
    if (mode === "project") {
      if (row.override === "load") return theme.fg("success", "[+]");
      if (row.override === "unload") return theme.fg("warning", "[-]");
      return theme.fg("dim", row.enabled ? "[x]" : "[ ]");
    }
    return theme.fg(row.enabled ? "success" : "dim", row.enabled ? "[x]" : "[ ]");
  };

  const suffix = (row: Row): string => {
    if (mode !== "project") return "";
    if (row.override === "load") return theme.fg("muted", "  project load");
    if (row.override === "unload") return theme.fg("muted", "  project unload");
    if (row.inherited) return theme.fg("dim", "  inherited global");
    return "";
  };

  const clampScroll = (): void => {
    const h = Math.max(1, deps.viewport());
    if (cursor < top) top = cursor;
    else if (cursor >= top + h) top = cursor - h + 1;
    if (top < 0) top = 0;
  };

  const render = (width: number): string[] => {
    clampScroll();
    const title = theme.bold("pi resources");
    const hints = deps.projectTrusted
      ? "tab mode  ·  space toggle  ·  / search  ·  esc close"
      : "space toggle  ·  / search  ·  esc close";
    const lines: string[] = [
      `${title}${" ".repeat(Math.max(1, width - title.length - hints.length))}${theme.fg("dim", hints)}`,
      theme.fg("muted", `> ${search || "search"}`),
      "",
    ];

    if (visible.length === 0) {
      lines.push(theme.fg("dim", "  No resources found"));
    } else {
      const h = Math.max(1, deps.viewport());
      // Count item rows and group headers both against the viewport.
      let budget = h;
      let inGroup: ResourceType | undefined;
      let rendered = 0;
      for (let i = top; i < visible.length && budget > 0; i++, rendered++) {
        const row = visible[i];
        if (row.resource.type !== inGroup) {
          inGroup = row.resource.type;
          lines.push(theme.fg("accent", TYPE_LABELS[inGroup]));
          budget--;
        }
        if (budget === 0) break;
        budget--;
        const cursorMark = i === cursor ? "> " : "  ";
        const name = row.resource.displayName + (row.packageRow ? " (package)" : "");
        const nameText = i === cursor ? theme.bold(name) : name;
        const body = `${cursorMark} ${renderCheckbox(row)} ${nameText}  ${row.resource.scope === "user" ? "global" : "project"}  ${row.resource.path}${suffix(row)}`;
        const clipped = body.slice(0, width);
        lines.push(row.inherited || row.packageRow ? theme.fg("dim", clipped) : clipped);
      }
      if (top + rendered < visible.length || top > 0) {
        lines.push(theme.fg("dim", `  (${cursor + 1}/${visible.length})`));
      }
    }

    lines.push("");
    const pending = changed ? theme.fg("warning", "  reload pending on close") : "";
    lines.push(theme.fg("dim", hints) + pending);
    if (busy) lines.push(theme.fg("muted", "writing settings..."));
    if (writeError) lines.push(theme.fg("error", writeError));
    return lines;
  };

  const handleInput = (data: string): void => {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      deps.close(changed);
      return;
    }
    if (matchesKey(data, "tab")) {
      switchMode();
      return;
    }
    if (matchesKey(data, "down")) {
      move(1);
      return;
    }
    if (matchesKey(data, "up")) {
      move(-1);
      return;
    }
    if (data === " " || matchesKey(data, "space")) {
      toggle();
      return;
    }
    if (matchesKey(data, "backspace") || data === "\x7f") {
      search = search.slice(0, -1);
      applyFilter();
      return;
    }
    if (data.length === 1 && data >= " ") {
      search += data;
      applyFilter();
    }
  };

  rebuild();

  return {
    render,
    handleInput,
    invalidate() {},
  };
}
