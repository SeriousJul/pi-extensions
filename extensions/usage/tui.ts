/**
 * The interactive Usage report, opened by the /usage command in TUI mode.
 *
 * One scan on open, then all filtering happens in memory. Every knob has a
 * key that is always visible in the legend row at the bottom:
 *
 *   b bucket  w window  g group  p provider  m model  s sort
 *   c columns d detail  r rescan  j/k rows  esc close
 */
import { matchesKey } from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { aggregate, windowLabel } from "./lib/aggregate.ts";
import { canonicalProvider } from "./lib/identity.ts";
import { fmtCost, fmtNum } from "./lib/render.ts";
import type { Bucket, GroupBy, Report, ReportOptions, SortBy, UsageEvent, Window } from "./lib/types.ts";

const BUCKETS: Bucket[] = ["week", "day", "month"];
const WINDOWS: Window[] = ["7d", "30d", "90d", "1y", "all"];
const GROUPS: GroupBy[] = ["providerModel", "provider", "model"];
const SORTS: SortBy[] = ["time", "tokens", "cost"];
const NUMERIC_FULL = ["In", "CacheR", "CacheW", "Out", "Reas", "Total", "Cost"];
const NUMERIC_COMPACT = ["In", "Cache", "Out", "Total", "Cost"];

const int = new Intl.NumberFormat("en-US");

function cycle<T extends string>(list: readonly T[], current: T): T {
  return list[(list.indexOf(current) + 1) % list.length];
}

export interface UsageTuiDeps {
  tui: TUI;
  theme: Theme;
  initial: ReportOptions;
  /** Runs the scan; resolves with all usage events. */
  load: () => Promise<UsageEvent[]>;
  /** How many table rows fit at the current terminal size. */
  viewport: () => number;
  /** Leaves the component (closes the TUI). */
  close: () => void;
}

export function createUsageTui(deps: UsageTuiDeps) {
  const { theme, tui } = deps;
  const dim = (s: string) => theme.fg("dim", s);
  const accent = (s: string) => theme.fg("accent", s);
  const error = (s: string) => theme.fg("error", s);

  let phase: "loading" | "ready" = "loading";
  let scanError: string | undefined;
  let events: UsageEvent[] = [];
  let options: ReportOptions = { ...deps.initial };
  let columns: "full" | "compact" = "full";
  let report: Report | null = null;
  let cursor = 0;
  let top = 0;
  let detail = false;
  let searchMode = false;
  let searchBuffer = options.model ?? "";

  const recompute = (): void => {
    report = aggregate(events, options, Date.now());
    // Keep the cursor where it is; only pull it back if the row set shrank.
    if (report && cursor > report.rows.length - 1) cursor = Math.max(0, report.rows.length - 1);
  };

  const resetView = (): void => {
    cursor = 0;
    top = 0;
    detail = false;
  };

  const startLoad = (): void => {
    phase = "loading";
    scanError = undefined;
    void deps
      .load()
      .then((ev) => {
        events = ev;
        recompute();
        resetView();
        phase = "ready";
        tui.requestRender();
      })
      .catch((e: unknown) => {
        events = [];
        report = null;
        resetView();
        phase = "ready";
        scanError = e instanceof Error ? e.message : String(e);
        tui.requestRender();
      });
  };
  startLoad();

  const providers = (): string[] => [...new Set(events.map((e) => canonicalProvider(e.provider)))].sort();

  const numericHeaders = (): string[] => (columns === "full" ? NUMERIC_FULL : NUMERIC_COMPACT);

  const countsOf = (c: { input: number; cacheRead: number; cacheWrite: number; output: number; reasoning: number; total: number; cost: number }): string[] =>
    columns === "full"
      ? [fmtNum(c.input), fmtNum(c.cacheRead), fmtNum(c.cacheWrite), fmtNum(c.output), fmtNum(c.reasoning), fmtNum(c.total), fmtCost(c.cost)]
      : [fmtNum(c.input), fmtNum(c.cacheRead + c.cacheWrite), fmtNum(c.output), fmtNum(c.total), fmtCost(c.cost)];

  const renderTable = (width: number): string[] => {
    if (!report) return [];
    const rep = report;
    const o = rep.options;
    const labelNames = ["Time", ...(o.groupBy === "model" ? [] : ["Provider"]), ...(o.groupBy === "provider" ? [] : ["Model"])];
    const labelGet: ((r: Report["rows"][number]) => string)[] = [
      (r) => r.bucket,
      ...(o.groupBy === "model" ? [] : [(r: Report["rows"][number]) => r.provider]),
      ...(o.groupBy === "provider" ? [] : [(r: Report["rows"][number]) => r.model]),
    ];
    const heads = numericHeaders();
    const gap = 2;
    const labelWidths = labelNames.map((n, i) => Math.max(n.length, ...rep.rows.map((r) => labelGet[i](r).length)));
    const numWidths = heads.map((h, i) =>
      Math.max(h.length, ...rep.rows.map((r) => countsOf(r.counts)[i].length), fmtNum(rep.total.total).length, "$0.0000".length),
    );
    // The table has a 2-column cursor marker column in front of it.
    const used = (): number =>
      labelWidths.reduce((a, b) => a + b, 0) + numWidths.reduce((a, b) => a + b, 0) + gap * (labelNames.length + heads.length - 1) + 2;
    let shrunk = 0;
    while (used() > width && shrunk < 200) {
      let widest = 0;
      for (let i = 1; i < labelWidths.length; i++) if (labelWidths[i] > labelWidths[widest]) widest = i;
      if (labelWidths[widest] <= 6) break;
      labelWidths[widest]--;
      shrunk++;
    }
    const trunc = (s: string, w: number) => (s.length > w ? s.slice(0, Math.max(1, w - 1)) + "…" : s);
    const row = (labelCells: string[], numericCells: string[]): string =>
      labelCells.map((c, i) => c.padEnd(labelWidths[i])).concat(numericCells.map((c, i) => c.padStart(numWidths[i]))).join(" ".repeat(gap));

    // The detail block borrows lines from the table viewport.
    const room = Math.max(4, deps.viewport() - (detail ? detailLines().length + 1 : 0));
    const out = ["  " + row(labelNames, heads)];
    for (const [i, r] of rep.rows.slice(top, top + room).entries()) {
      const mark = top + i === cursor ? "▶ " : "  ";
      out.push(mark + row(labelGet.map((get, j) => trunc(get(r), labelWidths[j])), countsOf(r.counts)));
    }
    out.push("  " + row(["TOTAL", ...labelNames.slice(1).map(() => "")], countsOf(rep.total)));
    return out;
  };

  const detailLines = (): string[] => {
    if (!report || !detail) return [];
    const r = report.rows[cursor];
    if (!r) return [];
    const head = accent(`${r.provider}${r.model ? ` / ${r.model}` : ""} - raw pairs:`);
    const body = r.raw.length > 0 ? r.raw.map((p) => dim(`  ${p.provider} / ${p.model}`)).slice(0, 5) : [dim("  (none)")];
    const more = r.raw.length > 5 ? [dim(`  ... ${r.raw.length - 5} more`)] : [];
    return [head, ...body, ...more];
  };

  const render = (width: number): string[] => {
    if (phase === "loading") return [accent("pi usage"), dim("scanning session files...")];
    if (scanError) return [accent("pi usage"), error(`scan failed: ${scanError}`), dim("esc close")];
    const o = report?.options ?? options;
    const lines: string[] = [accent("pi usage")];
    const knobs = [
      `b ${o.bucket}`,
      `w ${o.window}`,
      `g ${o.groupBy === "providerModel" ? "provider+model" : o.groupBy}`,
      `s ${o.sort}`,
      `c ${columns}`,
      o.provider ? `p ${o.provider}` : "p none",
      searchMode ? `m ~${searchBuffer}|` : o.model ? `m ~${o.model}` : "m none",
    ];
    lines.push(dim(knobs.join("   ")));
    if (report) lines.push(dim(`${int.format(report.events)} events · ${o.month ? o.month : windowLabel(o)}`));
    lines.push("");
    const detailBlock = detailLines();
    const table = renderTable(width - 2);
    lines.push(...table);
    if (detailBlock.length) {
      lines.push("");
      lines.push(...detailBlock);
    }
    lines.push("");
    lines.push(dim("b bucket  w window  g group  p provider  m model  s sort  c cols  d detail  r rescan  j/k rows  esc close"));
    return lines;
  };

  const handleInput = (data: string): void => {
    if (searchMode) {
      if (matchesKey(data, "escape") || matchesKey(data, "enter")) {
        searchMode = false;
      } else if (matchesKey(data, "backspace") || data === "\x7f") {
        searchBuffer = searchBuffer.slice(0, -1);
      } else if (data.length === 1 && data >= " " && !matchesKey(data, "escape")) {
        searchBuffer += data;
      } else {
        return;
      }
      options.model = searchBuffer.trim() || undefined;
      recompute();
      return;
    }
    if (matchesKey(data, "escape")) {
      deps.close();
      return;
    }
    if (matchesKey(data, "down") || data === "j") {
      if (report) cursor = Math.min(report.rows.length - 1, cursor + 1);
    } else if (matchesKey(data, "up") || data === "k") {
      if (report) cursor = Math.max(0, cursor - 1);
    } else if (matchesKey(data, "enter") || data === "d") {
      detail = !detail;
    } else if (data === "b") {
      options.bucket = cycle(BUCKETS, options.bucket);
    } else if (data === "w") {
      options.window = cycle(WINDOWS, options.window);
    } else if (data === "g") {
      options.groupBy = cycle(GROUPS, options.groupBy);
    } else if (data === "s") {
      options.sort = cycle(SORTS, options.sort);
    } else if (data === "c") {
      columns = columns === "full" ? "compact" : "full";
    } else if (data === "m") {
      searchMode = true;
      searchBuffer = options.model ?? "";
      return;
    } else if (data === "p") {
      // The cycle is none -> first provider -> ... -> last -> none.
      const list = [undefined, ...providers()];
      const idx = list.indexOf(options.provider);
      options.provider = list[(idx + 1) % list.length];
    } else if (data === "r") {
      startLoad();
      return;
    } else {
      return;
    }
    recompute();
  };

  // Keep the cursor inside the visible slice.
  const clampScroll = (): void => {
    if (!report) return;
    const h = deps.viewport();
    if (cursor < top) top = cursor;
    else if (cursor >= top + h) top = cursor - h + 1;
    if (top < 0) top = 0;
  };

  return {
    render: (width: number): string[] => {
      clampScroll();
      return render(width);
    },
    handleInput,
    // The TUI re-renders after every input and we call requestRender on
    // async state changes, so nothing to invalidate here.
    invalidate() {},
  };
}
