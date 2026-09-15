/**
 * pi-usage: LLM token and cost reporting across all pi sessions.
 *
 *   pi-usage report [--by day|week|month] [--by provider|model]
 *                   [--since 7d|30d|90d|1y|all] [--month YYYY-MM]
 *                   [--json]
 *   pi-usage sessions
 *
 * Default: last 30 days, weekly buckets, provider+model groups, a grand
 * total row. `--json` emits the report rows and totals as JSON.
 */
import { aggregate, emptyReportOptions } from "./lib/aggregate.ts";
import { defaultSessionsRoot, scanUsage } from "./lib/scan.ts";
import { fmtCost, renderReportText } from "./lib/render.ts";
import type { ReportOptions } from "./lib/types.ts";

const HELP = `pi-usage: LLM token and cost reporting across all pi sessions

Usage:
  pi-usage report [options]   Show the usage report (default)
  pi-usage sessions           List sessions with their totals
  pi-usage help               Show this help

Report options:
  --by day|week|month         Time bucket
  --by provider|model         Group rows by one axis
  --since 7d|30d|90d|1y|all   Time window (default: 30d)
  --month YYYY-MM             One calendar month (overrides --since)
  --json                      Emit JSON

Data: every .jsonl under ~/.pi/agent/sessions/ (override with the
PI_SESSIONS_DIR environment variable). See docs/adr/0008 and docs/adr/0009
for how the numbers are derived and counted.`;

interface Parsed {
  options: ReportOptions;
  json: boolean;
  error?: string;
}

function parseReportFlags(args: string[]): Parsed {
  const options: ReportOptions = { ...emptyReportOptions() };
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") {
      json = true;
      continue;
    }
    if (a === "--by") {
      const v = args[++i];
      if (v === "day" || v === "week" || v === "month") options.bucket = v;
      else if (v === "provider" || v === "model") options.groupBy = v;
      else return { options, json, error: `--by takes day, week, month, provider, or model (got ${v ?? ""})` };
      continue;
    }
    if (a === "--since") {
      const v = args[++i];
      if (v === "7d" || v === "30d" || v === "90d" || v === "1y" || v === "all") options.window = v;
      else return { options, json, error: `--since takes 7d, 30d, 90d, 1y, or all (got ${v ?? ""})` };
      continue;
    }
    if (a === "--month") {
      const v = args[++i];
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(v ?? "")) return { options, json, error: `--month takes YYYY-MM (got ${v ?? ""})` };
      options.month = v;
      continue;
    }
    return { options, json, error: `unknown flag: ${a}` };
  }
  return { options, json };
}

function runReport(args: string[]): number {
  const parsed = parseReportFlags(args);
  if (parsed.error) {
    console.error(`pi-usage: ${parsed.error}`);
    return 1;
  }
  const { events } = scanUsage(defaultSessionsRoot());
  const report = aggregate(events, parsed.options);
  if (parsed.json) {
    console.log(JSON.stringify({ options: report.options, events: report.events, rows: report.rows, total: report.total }, null, 2));
    return 0;
  }
  // On a narrow terminal the full column set cannot fit; compact merges
  // cache and reasoning into two columns. Piped output stays full.
  const width = process.stdout.columns;
  const columns = width !== undefined && width < 120 ? "compact" : "full";
  console.log(renderReportText(report, { width, columns }));
  return 0;
}

function runSessions(): number {
  const { sessions, files } = scanUsage(defaultSessionsRoot());
  const list = [...sessions].sort((a, b) => b.firstTs - a.firstTs);
  const int = new Intl.NumberFormat("en-US");
  console.log(`pi-usage sessions (${int.format(files)} files, newest first)`);
  for (const s of list) {
    const first = s.firstTs ? new Date(s.firstTs).toISOString().slice(0, 16).replace("T", " ") : "unknown";
    console.log(`${first}  ${int.format(s.events).padStart(6)} ev  ${int.format(s.total).padStart(10)} tok  ${fmtCost(s.cost).padStart(9)}  ${s.cwd}  ${s.file}`);
  }
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const [command = "report", ...rest] = argv;
  if (command === "help" || rest.includes("--help") || rest.includes("-h")) {
    console.log(HELP);
    return 0;
  }
  if (command === "report") return runReport(rest);
  if (command === "sessions") return runSessions();
  console.error(`pi-usage: unknown command: ${command}`);
  console.error(HELP);
  return 1;
}
