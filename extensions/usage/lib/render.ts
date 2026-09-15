/**
 * Text rendering of a Usage report, shared by the CLI and the agent tool.
 * The TUI renders its own colored view from the same report data.
 */
import { windowLabel } from "./aggregate.ts";
import type { Report, ReportCounts, ReportRow } from "./types.ts";

const int = new Intl.NumberFormat("en-US");

export function fmtCost(v: number): string {
  if (v === 0) return "$0.00";
  if (Math.abs(v) < 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
}

/**
 * Compact number for the TUI: exact under 10,000, then k/M/B/T with one
 * decimal below 100 in the unit (949M, 20.3M, 2B). The CLI keeps exact
 * digits; the TUI is for scanning shape, not copying values.
 */
export function fmtNum(n: number): string {
  if (n < 10_000) return String(n);
  const units: Array<[number, string]> = [
    [1e12, "T"],
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "k"],
  ];
  let i = units.findIndex(([s]) => n >= s);
  // 999,999 would round to 1000k; carry up to 1M instead.
  if (i === units.length - 1 && n / 1e3 >= 999.5) i -= 1;
  const [size, suffix] = units[i];
  const v = n / size;
  const s = v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10);
  return s + suffix;
}

export interface RenderOptions {
  columns?: "full" | "compact";
  /** Truncate label columns to fit this many columns (optional). */
  width?: number;
}

interface NumericColumn {
  header: string;
  cell: (counts: ReportCounts) => string;
}

function numericColumns(columns: "full" | "compact"): NumericColumn[] {
  const col = (header: string, get: (c: ReportCounts) => string): NumericColumn => ({ header, cell: get });
  const cols: NumericColumn[] = [col("In", (c) => int.format(c.input))];
  if (columns === "full") {
    cols.push(col("CacheR", (c) => int.format(c.cacheRead)), col("CacheW", (c) => int.format(c.cacheWrite)));
  } else {
    cols.push(col("Cache", (c) => int.format(c.cacheRead + c.cacheWrite)));
  }
  cols.push(col("Out", (c) => int.format(c.output)));
  if (columns === "full") cols.push(col("Reas", (c) => int.format(c.reasoning)));
  cols.push(col("Total", (c) => int.format(c.total)), col("Cost", (c) => fmtCost(c.cost)));
  return cols;
}

export function renderReportText(report: Report, opts: RenderOptions = {}): string {
  const o = report.options;
  const labelDefs: { name: string; get: (row: ReportRow) => string }[] = [{ name: "Time", get: (row) => row.bucket }];
  if (o.groupBy !== "model") labelDefs.push({ name: "Provider", get: (row) => row.provider });
  if (o.groupBy !== "provider") labelDefs.push({ name: "Model", get: (row) => row.model });
  const nums = numericColumns(opts.columns ?? "full");
  const gap = 2;

  // Natural widths, then shrink label columns to fit the requested width.
  const labelWidths = labelDefs.map((l) => Math.max(l.name.length, ...report.rows.map((row) => l.get(row).length)));
  const numWidths = nums.map((c) =>
    Math.max(c.header.length, ...report.rows.map((row) => c.cell(row.counts).length), `TOTAL ${int.format(report.total.total)}`.length),
  );
  const totalWidth = (): number =>
    labelWidths.reduce((a, b) => a + b, 0) + numWidths.reduce((a, b) => a + b, 0) + gap * (labelDefs.length + nums.length - 1);
  let shrunk = 0;
  while (opts.width !== undefined && totalWidth() > opts.width && shrunk < 200) {
    let widest = 0;
    for (let j = 1; j < labelWidths.length; j++) if (labelWidths[j] > labelWidths[widest]) widest = j;
    if (labelWidths[widest] <= 6) break;
    labelWidths[widest]--;
    shrunk++;
  }
  const trunc = (s: string, w: number): string => (s.length > w ? s.slice(0, Math.max(1, w - 1)) + "…" : s);
  const line = (labelCells: string[], numericCells: string[]): string =>
    labelCells
      .map((cell, j) => cell.padEnd(labelWidths[j]))
      .concat(numericCells.map((cell, j) => cell.padStart(numWidths[j])))
      .join(" ".repeat(gap));

  const countsOf = (counts: ReportCounts): string[] => nums.map((c) => c.cell(counts));

  const lines: string[] = ["pi usage report"];
  const groupLabel = o.groupBy === "providerModel" ? "provider+model" : o.groupBy;
  lines.push(
    `${windowLabel(o)} · ${o.bucket} · ${groupLabel} · sort: ${o.sort} · ${int.format(report.events)} events` +
      (o.provider ? ` · provider: ${o.provider}` : "") +
      (o.model ? ` · model: ~${o.model}` : ""),
  );
  lines.push("");
  lines.push(line(labelDefs.map((l) => l.name), nums.map((c) => c.header)));
  for (const row of report.rows) {
    const cells = labelDefs.map((l) => trunc(l.get(row), labelWidths[labelDefs.findIndex((d) => d === l)]));
    lines.push(line(cells, countsOf(row.counts)));
  }
  lines.push(line([`TOTAL`, ...labelDefs.slice(1).map(() => "")], countsOf(report.total)));
  return lines.join("\n");
}
