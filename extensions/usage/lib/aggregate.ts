/**
 * Aggregate a Usage scan into a report: window and filter, then one row per
 * (time bucket, Canonical identity), with a grand total.
 *
 * Bucketing is calendar-based in the caller's timezone. Bucket and window
 * helpers take an explicit UTC offset (minutes) so tests are deterministic;
 * `aggregate` passes the local offset.
 */
import { canonicalIdentity } from "./identity.ts";
import type { Bucket, Report, ReportCounts, ReportOptions, ReportRow, SortBy, UsageEvent, Window } from "./types.ts";

export const EMPTY_COUNTS: ReportCounts = {
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  reasoning: 0,
  total: 0,
  cost: 0,
};

export function emptyReportOptions(): ReportOptions {
  return { bucket: "week", window: "30d", groupBy: "providerModel", sort: "time" };
}

const pad = (n: number): string => String(n).padStart(2, "0");

/**
 * The bucket label for a timestamp.
 * `tzOffsetMinutes` is the UTC offset in minutes (as in
 * `-date.getTimezoneOffset()`).
 */
export function bucketKeyFor(ts: number, bucket: Bucket, tzOffsetMinutes: number): string {
  const d = new Date(ts + tzOffsetMinutes * 60000);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  if (bucket === "day") return `${year}-${pad(month)}-${pad(day)}`;
  if (bucket === "month") return `${year}-${pad(month)}`;
  // ISO week: the week starts Monday and the year is the week's Thursday's.
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  const thursday = new Date(Date.UTC(year, d.getUTCMonth(), day - dow + 3));
  const isoYear = thursday.getUTCFullYear();
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4dow = (jan4.getUTCDay() + 6) % 7;
  const week1Monday = new Date(Date.UTC(isoYear, 0, 4 - jan4dow));
  const week = 1 + Math.round((thursday.getTime() - week1Monday.getTime()) / (7 * 86400000));
  return `${isoYear}-W${pad(week)}`;
}

/**
 * Start of the window in epoch milliseconds. `tzOffsetMinutes` is the local
 * offset at `now`.
 */
export function windowStartFor(window: Window, now: number, tzOffsetMinutes: number): number {
  if (window === "all") return 0;
  const days = window === "7d" ? 7 : window === "30d" ? 30 : window === "90d" ? 90 : 365;
  const shifted = new Date(now + tzOffsetMinutes * 60000);
  const startOfToday = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
  return startOfToday - (days - 1) * 86400000 - tzOffsetMinutes * 60000;
}

/** True when `ts` falls in the calendar month "YYYY-MM" at the offset. */
export function inMonthFor(ts: number, month: string, tzOffsetMinutes: number): boolean {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) throw new Error(`bad month: ${month}`);
  const d = new Date(ts + tzOffsetMinutes * 60000);
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() + 1 === Number(m[2]);
}

export function sortRows(rows: ReportRow[], sort: SortBy): ReportRow[] {
  const byTime = (a: ReportRow, b: ReportRow): number =>
    a.bucket.localeCompare(b.bucket) || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model);
  const out = [...rows];
  if (sort === "tokens") out.sort((a, b) => b.counts.total - a.counts.total || byTime(a, b));
  else if (sort === "cost") out.sort((a, b) => b.counts.cost - a.counts.cost || byTime(a, b));
  else out.sort(byTime);
  return out;
}

export function aggregate(events: UsageEvent[], options: ReportOptions, now: number = Date.now()): Report {
  const offset = -new Date(now).getTimezoneOffset();
  const month = options.month;
  const start = month ? 0 : windowStartFor(options.window, now, offset);

  const rows = new Map<string, ReportRow>();
  const raws = new Map<string, Map<string, { provider: string; model: string }>>();
  const total: ReportCounts = { ...EMPTY_COUNTS };
  let counted = 0;

  for (const e of events) {
    // Zero-only events (aborted calls, unmeasured work) cannot change a
    // total, so the report drops them instead of rendering empty rows.
    if (e.input + e.cacheRead + e.cacheWrite + e.output + e.reasoning + e.total === 0 && e.cost === 0) continue;
    if (month) {
      if (!inMonthFor(e.ts, month, offset)) continue;
    } else if (options.window !== "all") {
      // Bounded windows are [start, now]; all time has no upper bound.
      if (e.ts < start || e.ts > now) continue;
    }
    const id = canonicalIdentity(e.provider, e.model);
    if (options.provider && id.provider !== options.provider) continue;
    if (options.model && !id.model.toLowerCase().includes(options.model.toLowerCase())) continue;

    const bucket = bucketKeyFor(e.ts, options.bucket, offset);
    const key =
      options.groupBy === "providerModel"
        ? `${bucket}\u0000${id.provider}\u0000${id.model}`
        : options.groupBy === "provider"
          ? `${bucket}\u0000${id.provider}\u0000`
          : `${bucket}\u0000\u0000${id.model}`;

    let row = rows.get(key);
    if (!row) {
      row = {
        bucket,
        provider: options.groupBy === "model" ? "" : id.provider,
        model: options.groupBy === "provider" ? "" : id.model,
        raw: [],
        counts: { ...EMPTY_COUNTS },
      };
      rows.set(key, row);
      raws.set(key, new Map());
    }
    row.counts.input += e.input;
    row.counts.cacheRead += e.cacheRead;
    row.counts.cacheWrite += e.cacheWrite;
    row.counts.output += e.output;
    row.counts.reasoning += e.reasoning;
    row.counts.total += e.total;
    row.counts.cost += e.cost;

    const rawKey = `${e.provider}\u0000${e.model}`;
    let rawMap = raws.get(key);
    if (!rawMap) {
      rawMap = new Map();
      raws.set(key, rawMap);
    }
    if (!rawMap.has(rawKey)) rawMap.set(rawKey, { provider: e.provider, model: e.model });

    total.input += e.input;
    total.cacheRead += e.cacheRead;
    total.cacheWrite += e.cacheWrite;
    total.output += e.output;
    total.reasoning += e.reasoning;
    total.total += e.total;
    total.cost += e.cost;
    counted++;
  }

  const rowList = [...rows.entries()].map(([key, row]) => {
    row.raw = [...(raws.get(key)?.values() ?? [])].sort((a, b) =>
      a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model),
    );
    return row;
  });

  return { options: { ...options }, rows: sortRows(rowList, options.sort), total, events: counted };
}

export function windowLabel(options: ReportOptions): string {
  if (options.month) return options.month;
  switch (options.window) {
    case "7d":
      return "last 7 days";
    case "30d":
      return "last 30 days";
    case "90d":
      return "last 90 days";
    case "1y":
      return "last year";
    case "all":
      return "all time";
  }
}
