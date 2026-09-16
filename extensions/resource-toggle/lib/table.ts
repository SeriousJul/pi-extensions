/**
 * The shared text table renderer, used by the headless command path and
 * the tool's list action.
 */
import { homedir } from "node:os";
import { resourceLabel } from "./state-machine.ts";
import type { OverrideState, ResourceInfo } from "./types.ts";

export interface TableRow {
  resource: ResourceInfo;
  /** The state the row shows: own-scope state in the global view. */
  enabled: boolean;
  /** Present in the project view: the project override of the resource. */
  override?: OverrideState;
}

export const shortPath = (path: string): string => {
  const home = homedir();
  if (path === home) return "~";
  if (path.startsWith(home + "/")) return `~${path.slice(home.length)}`;
  return path;
};

const stateText = (row: TableRow): string => {
  const base = row.enabled ? "enabled" : "disabled";
  if (row.override === undefined) return base;
  if (row.override === "load") return `${base} (project load)`;
  if (row.override === "unload") return `${base} (project unload)`;
  return row.resource.scope === "user" ? `${base} (inherited)` : base;
};

/**
 * Render a text table of resources: NAME, TYPE, SCOPE, LOCATION, STATE.
 */
export function renderResourceTable(rows: TableRow[]): string {
  if (rows.length === 0) return "No resources found.";

  const body = rows.map((row) => {
    const name = row.resource.displayName + (row.resource.origin === "package" ? " (package)" : "");
    return [
      name,
      resourceLabel(row.resource.type),
      row.resource.scope === "user" ? "global" : "project",
      shortPath(row.resource.path),
      stateText(row),
    ];
  });
  const header = ["NAME", "TYPE", "SCOPE", "LOCATION", "STATE"];
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((row) => row[i].length)));
  const line = (cells: string[]): string =>
    cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]))).join("  ");
  return [line(header), ...body.map(line)].join("\n");
}

/** The rows for the global view: own-scope state per resource. */
export function globalViewRows(resources: ResourceInfo[]): TableRow[] {
  return resources.map((resource) => ({ resource, enabled: resource.ownEnabled }));
}

/** The rows for the project view: effective state plus the project override. */
export function projectViewRows(resources: ResourceInfo[], overrides: Map<ResourceInfo, OverrideState>): TableRow[] {
  return resources.map((resource) => {
    const override = overrides.get(resource);
    const enabled =
      override === "load" ? true : override === "unload" ? false : resource.enabled;
    return { resource, enabled, override };
  });
}
