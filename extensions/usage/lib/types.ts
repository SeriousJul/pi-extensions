/**
 * Shared types for the Usage extension.
 */

/**
 * One LLM call's recorded usage in a session file: an assistant reply, a
 * tool's nested LLM work, or a compaction summary.
 */
export interface UsageEvent {
  /** Epoch milliseconds of the entry timestamp. */
  ts: number;
  /** Provider as recorded in the session (raw, before canonical identity). */
  provider: string;
  /** Model as recorded in the session (raw, before canonical identity). */
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  total: number;
  cost: number;
}

/** Per-session totals for the `sessions` subcommand. */
export interface SessionSummary {
  /** Absolute path of the session file. */
  file: string;
  /** Working directory recorded in the session header. */
  cwd: string;
  /** Epoch milliseconds of the session header. */
  firstTs: number;
  total: number;
  cost: number;
  /** Usage events this file contributed (fork-shared history counts once). */
  events: number;
}

export interface ScanResult {
  events: UsageEvent[];
  sessions: SessionSummary[];
  files: number;
  /** Lines that carried usage but could not be parsed (a line mid-write). */
  skipped: number;
}

export type Bucket = "day" | "week" | "month";
export type GroupBy = "providerModel" | "provider" | "model";
export type Window = "7d" | "30d" | "90d" | "1y" | "all";
export type SortBy = "time" | "tokens" | "cost";

export interface ReportOptions {
  bucket: Bucket;
  window: Window;
  /** One calendar month as "YYYY-MM". Takes precedence over `window`. */
  month?: string;
  groupBy: GroupBy;
  sort: SortBy;
  /** Filter to one canonical provider. */
  provider?: string;
  /** Case-insensitive substring on the canonical model name. */
  model?: string;
}

export interface ReportCounts {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  total: number;
  cost: number;
}

export interface ReportRow {
  /** Bucket label: "2026-09-15" | "2026-W38" | "2026-09". */
  bucket: string;
  /** Canonical provider (empty when grouped by model only). */
  provider: string;
  /** Canonical model (empty when grouped by provider only). */
  model: string;
  /** Distinct raw (provider, model) pairs that made up this row. */
  raw: { provider: string; model: string }[];
  counts: ReportCounts;
}

export interface Report {
  options: ReportOptions;
  rows: ReportRow[];
  total: ReportCounts;
  /** Non-zero usage events that fell inside the window and filters. */
  events: number;
}
