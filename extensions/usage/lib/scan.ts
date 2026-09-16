/**
 * The Usage scan: one pass over every session file that extracts every
 * usage event exactly once.
 *
 * pi records usage on three kinds of entries:
 *
 * - assistant messages, which carry their own provider and model
 * - tool results that did nested LLM work, which carry usage only
 * - compaction and branch summary entries, which carry usage only
 *
 * Forked and cloned sessions copy their ancestor's entry lines
 * byte-identical, so a usage line is counted once per distinct line
 * (ADR 0009). Events that carry no provider or model are attributed to the
 * session's active model at their position in the entry tree: the nearest
 * model_change walking the parentId chain, or "unknown" when none exists.
 *
 * A partial trailing line in a live session fails to parse and is skipped.
 */
import type { ScanResult, SessionSummary, UsageEvent } from "./types.ts";
import {
defaultSessionsRoot,
  listSessionFiles,
  readSessionText,
  SESSIONS_DIR_ENV,
} from "../../shared/sessions.ts";

// Re-exported so the CLI and the extension keep importing the sessions root
// from this module.
export { defaultSessionsRoot, SESSIONS_DIR_ENV };

interface SessionEntry {
  type?: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  cwd?: string;
  provider?: string;
  modelId?: string;
  usage?: UsageFields;
  message?: {
    role?: string;
    provider?: string;
    model?: string;
    usage?: UsageFields;
    timestamp?: number;
  };
}

interface UsageFields {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  totalTokens?: number;
  cost?: { total?: number };
}

/** A usage event with its attribution data, before the active model is resolved. */
interface PendingEvent {
  ts: number;
  provider?: string;
  model?: string;
  parentId: string | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  total: number;
  cost: number;
}

const UNKNOWN = { provider: "unknown", model: "unknown" };

function num(v: number | undefined): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function entryTs(entry: SessionEntry): number {
  const iso = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
  if (Number.isFinite(iso)) return iso;
  const epoch = entry.message?.timestamp;
  if (typeof epoch === "number" && Number.isFinite(epoch)) return epoch;
  return 0;
}

/**
 * Extract usage events from one session file's text.
 *
 * `seen` is the set of usage lines already counted (global across files),
 * so fork-copied lines never double count.
 */
function scanFile(text: string, file: string, seen: Set<string>, out: { events: UsageEvent[]; sessions: SessionSummary[]; skipped: { n: number } }): void {
  const byId = new Map<string, string | null>();
  const modelChange = new Map<string, { provider: string; model: string }>();
  const modelMemo = new Map<string, { provider: string; model: string }>();
  const pending: PendingEvent[] = [];
  let cwd = "";
  let firstTs = 0;
  let fileEvents = 0;
  let fileTotal = 0;
  let fileCost = 0;

  for (const line of text.split("\n")) {
    if (!line) continue;
    let entry: SessionEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      if (line.includes('"usage"')) out.skipped.n++;
      continue;
    }
    if (typeof entry.id === "string") byId.set(entry.id, entry.parentId ?? null);

    if (entry.type === "session") {
      cwd = typeof entry.cwd === "string" ? entry.cwd : "";
      const ts = Date.parse(entry.timestamp ?? "");
      firstTs = Number.isFinite(ts) ? ts : 0;
      continue;
    }

    if (entry.type === "model_change" && typeof entry.id === "string") {
      modelChange.set(entry.id, {
        provider: typeof entry.provider === "string" ? entry.provider : UNKNOWN.provider,
        model: typeof entry.modelId === "string" ? entry.modelId : UNKNOWN.model,
      });
      continue;
    }

    let usage: UsageFields | undefined;
    let provider: string | undefined;
    let model: string | undefined;
    if (entry.type === "message" && entry.message && entry.message.usage) {
      usage = entry.message.usage;
      provider = entry.message.provider;
      model = entry.message.model;
    } else if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) {
      usage = entry.usage;
    }
    if (!usage) continue;

    if (seen.has(line)) continue; // a fork copy: already counted
    seen.add(line);

    pending.push({
      ts: entryTs(entry),
      provider,
      model,
      parentId: entry.parentId ?? null,
      input: num(usage.input),
      output: num(usage.output),
      cacheRead: num(usage.cacheRead),
      cacheWrite: num(usage.cacheWrite),
      reasoning: num(usage.reasoning),
      total: num(usage.totalTokens),
      cost: num(usage.cost?.total),
    });
    fileEvents++;
    fileTotal += num(usage.totalTokens);
    fileCost += num(usage.cost?.total);
  }

  // The active model for an entry: the nearest model_change up its parent
  // chain, memoized so every chain walk is amortized linear in the file.
  const activeModel = (startId: string | null): { provider: string; model: string } => {
    if (!startId) return UNKNOWN;
    const chain: string[] = [];
    let cur: string | null = startId;
    let result: { provider: string; model: string } | undefined;
    while (cur) {
      if (modelMemo.has(cur)) {
        result = modelMemo.get(cur);
        break;
      }
      const change = modelChange.get(cur);
      if (change) {
        result = change;
        break;
      }
      chain.push(cur);
      cur = byId.get(cur) ?? null;
    }
    if (!result) result = UNKNOWN;
    for (const id of chain) modelMemo.set(id, result);
    return result;
  };

  for (const p of pending) {
    const identity = p.provider && p.model ? { provider: p.provider, model: p.model } : activeModel(p.parentId);
    out.events.push({
      ts: p.ts,
      provider: identity.provider,
      model: identity.model,
      input: p.input,
      output: p.output,
      cacheRead: p.cacheRead,
      cacheWrite: p.cacheWrite,
      reasoning: p.reasoning,
      total: p.total,
      cost: p.cost,
    });
  }

  out.sessions.push({ file, cwd, firstTs, total: fileTotal, cost: fileCost, events: fileEvents });
}

export function scanUsage(root: string): ScanResult {
  const events: UsageEvent[] = [];
  const sessions: SessionSummary[] = [];
  const seen = new Set<string>();
  const skipped = { n: 0 };
  let files = 0;

  for (const sf of listSessionFiles(root)) {
    files++;
    const text = readSessionText(sf.file);
    if (text === undefined) continue;
    scanFile(text, sf.file, seen, { events, sessions, skipped });
  }

  return { events, sessions, files, skipped: skipped.n };
}
