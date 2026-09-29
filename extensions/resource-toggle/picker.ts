/**
 * The resource picker: the single-pick TUI surface opened when /enable,
 * /disable, or /inherit runs without a name.
 *
 * Built over the interactive list's row building and row rendering:
 * every resource is a row - the
 * grid's first line (state mark, display name, scope, path) and the dimmed
 * description line beneath, clipped to the terminal width. A row whose
 * pick would be a no-op in the active mode is dimmed (for inherit: a row
 * without a project override). Typing filters by name, path, or kind.
 *
 * Enter applies exactly the toggle the named call would apply in the
 * active mode - same self-guard, same write, same report - and closes only
 * on a successful change. A no-op pick and a failed write show their
 * message and keep the picker open. Esc closes with no change.
 */
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { projectOverrideState, resourceLabel } from "./lib/state-machine.ts";
import type { MachineContext, ResourceInfo, ResourceType, SettingsState, ToggleOp, WriteMode } from "./lib/types.ts";
import { RESOURCE_TYPES } from "./lib/types.ts";
import { buildResourceRows, refOf, renderResourceRow, type ResourceRow } from "./tui.ts";

const TYPE_LABELS: Record<ResourceType, string> = {
  extensions: "Extensions",
  skills: "Skills",
  prompts: "Prompts",
  themes: "Themes",
};

export interface ResourcePickerDeps {
  tui: TUI;
  theme: Theme;
  /** The one toggle a pick applies. */
  operation: ToggleOp;
  /** The mode the picker opens in (project mode for inherit). */
  initialMode: WriteMode;
  /** Every loadable resource, canonical own-scope identity. */
  resources: ResourceInfo[];
  /** The settings arrays at open; a pick re-reads them through applyPick. */
  settings: SettingsState;
  machine: { cwd: string; agentDir: string; configDir: string };
  /** Whether the project view is available (project trusted). */
  projectTrusted: boolean;
  /** The self-guard: is this path the loaded resource-toggle? */
  isSelf: (path: string) => boolean;
  /** Applies the pick: the same self-guard, write, and report the named call runs. */
  applyPick: (resource: ResourceInfo) => Promise<{ ok: boolean; text: string }>;
  /** How many item lines fit at the current terminal size. */
  viewport: () => number;
  /** Leaves the picker; the result is the successful pick's report. */
  close: (result: { text: string } | null) => void;
}

export function createResourcePickerTui(deps: ResourcePickerDeps) {
  const { theme, tui, operation } = deps;
  const settings = deps.settings;

  let mode: WriteMode = deps.initialMode;
  let search = "";
  let cursor = 0;
  let top = 0;
  let busy = false;
  let note: string | undefined; // the no-op or refusal line
  let error: string | undefined; // the failed-write line

  let rows: ResourceRow[] = [];
  let visible: ResourceRow[] = [];

  /** Would a pick of this row in the active mode change nothing? */
  const noOp = (row: ResourceRow): boolean => {
    if (row.resource.origin === "package") return true;
    if (deps.isSelf(row.resource.path) && operation.op !== "enable") return true;
    if (operation.op === "inherit") {
      return projectOverrideState(settings, refOf(row.resource), deps.machine) === "inherit";
    }
    return operation.op === "enable" ? row.enabled : !row.enabled;
  };

  const noOpMessage = (row: ResourceRow): string => {
    const name = row.resource.displayName;
    if (operation.op === "inherit") return `No change: "${name}" has no project override to clear.`;
    const state = operation.op === "enable" ? "enabled" : "disabled";
    return `No change: "${name}" is already ${state} in ${mode === "project" ? "project" : "global"} mode.`;
  };

  const rebuild = (): void => {
    rows = buildResourceRows(deps.resources, settings, deps.machine, mode);
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
      error = "Project mode unavailable: the project is not trusted.";
      tui.requestRender();
      return;
    }
    mode = mode === "global" ? "project" : "global";
    note = undefined;
    error = undefined;
    rebuild();
    tui.requestRender();
  };

  const move = (delta: number): void => {
    if (visible.length === 0) return;
    cursor = Math.max(0, Math.min(visible.length - 1, cursor + delta));
  };

  const pick = (): void => {
    const row = visible[cursor];
    if (!row || busy) return;
    if (row.resource.origin === "package") {
      note = `Refused: "${row.resource.displayName}" is a package resource; package rows are read-only.`;
      tui.requestRender();
      return;
    }
    if (deps.isSelf(row.resource.path) && operation.op !== "enable") {
      note = `Refused: resource-toggle will not ${operation.op} itself; that would remove the toggle commands.`;
      tui.requestRender();
      return;
    }
    if (noOp(row)) {
      note = noOpMessage(row);
      tui.requestRender();
      return;
    }
    busy = true;
    note = undefined;
    error = undefined;
    tui.requestRender();
    void deps
      .applyPick(row.resource)
      .then((result) => {
        busy = false;
        if (result.ok) {
          deps.close({ text: result.text });
        } else {
          error = result.text;
          tui.requestRender();
        }
      })
      .catch((pickError: unknown) => {
        busy = false;
        error = pickError instanceof Error ? pickError.message : String(pickError);
        tui.requestRender();
      });
  };

  const clampScroll = (): void => {
    const h = Math.max(1, deps.viewport());
    if (cursor < top) top = cursor;
    else if (cursor >= top + h) top = cursor - h + 1;
    if (top < 0) top = 0;
  };

  const render = (width: number): string[] => {
    clampScroll();
    const title = theme.bold(`pick a resource to ${operation.op}`);
    const hints = deps.projectTrusted
      ? "tab mode  ·  enter pick  ·  type to filter  ·  esc close"
      : "enter pick  ·  type to filter  ·  esc close";
    const pad = Math.max(1, width - visibleWidth(title) - visibleWidth(hints));
    const lines: string[] = [
      truncateToWidth(`${title}${" ".repeat(pad)}${theme.fg("dim", hints)}`, width),
      theme.fg("muted", `> ${search || "filter"}`),
      "",
    ];

    if (visible.length === 0) {
      lines.push(theme.fg("dim", "  No resources found"));
    } else {
      const h = Math.max(1, deps.viewport());
      let budget = h;
      let inGroup: ResourceType | undefined;
      let rendered = 0;
      for (let i = top; i < visible.length && budget > 0; i++, rendered++) {
        const row = visible[i];
        if (row.resource.type !== inGroup) {
          inGroup = row.resource.type;
          lines.push(theme.fg("accent", TYPE_LABELS[inGroup]));
          budget--;
          if (budget === 0) break;
        }
        const rowLines = renderResourceRow(row, { cursor: i === cursor, width, theme, mode, dim: noOp(row) });
        lines.push(...rowLines);
        budget -= rowLines.length;
      }
      if (top + rendered < visible.length || top > 0) {
        lines.push(theme.fg("dim", `  (${cursor + 1}/${visible.length})`));
      }
    }

    lines.push("");
    lines.push(truncateToWidth(theme.fg("dim", hints), width));
    if (busy) lines.push(theme.fg("muted", "writing settings..."));
    if (note) lines.push(theme.fg("muted", note));
    if (error) lines.push(theme.fg("error", error));
    return lines;
  };

  const handleInput = (data: string): void => {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      deps.close(null);
      return;
    }
    if (matchesKey(data, "tab")) {
      switchMode();
      return;
    }
    if (matchesKey(data, "enter") || data === "\r") {
      pick();
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
