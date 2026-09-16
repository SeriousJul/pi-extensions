/**
 * Core tests for the Usage extension: the scan (extraction, fork dedupe,
 * branch attribution, partial lines), the alias rules, the bucket and
 * window math, the aggregate, and the text rendering.
 *
 * All fixtures are synthetic session files written to a temp directory, so
 * the tests run anywhere without a real session tree.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { aggregate, bucketKeyFor, emptyReportOptions, inMonthFor, windowStartFor } from "../../extensions/usage/lib/aggregate.ts";
import { canonicalModel, canonicalProvider } from "../../extensions/usage/lib/identity.ts";
import { fmtNum, renderReportText } from "../../extensions/usage/lib/render.ts";
import { scanUsage } from "../../extensions/usage/lib/scan.ts";
import { buildFixtureRoot } from "./fixtures.ts";
import type { UsageEvent } from "../../extensions/usage/lib/types.ts";

const nowSep16 = Date.parse("2026-09-16T12:00:00.000Z");

// --- fixture -------------------------------------------------------------

let root = "";
let events: UsageEvent[] = [];

beforeAll(() => {
  root = buildFixtureRoot();
  events = scanUsage(root).events;
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

// --- scan -----------------------------------------------------------------

describe("scan", () => {
  it("counts each usage event exactly once across forked sessions", () => {
    const { events, files } = scanUsage(root);
    expect(files).toBe(3);
    // The compress-span line exists byte-identical in a.jsonl and its fork
    // b.jsonl: it is counted once.
    expect(events).toHaveLength(9);
    expect(events.reduce((s, e) => s + e.total, 0)).toBe(2900);
  });

  it("does not count the compaction retained tail", () => {
    expect(events.some((e) => e.total === 777)).toBe(false);
  });

  it("attributes provider-less usage to the active model on its branch", () => {
    const byTotal = new Map(events.map((e) => [e.total, e]));
    const tool = byTotal.get(10);
    expect(tool?.provider).toBe("llama.cpp");
    expect(tool?.model).toBe("unsloth/Qwen3.8-27B-GGUF:Q4_K_XL");
    const compaction = byTotal.get(15);
    expect(compaction?.provider).toBe("llama-server=http://127.0.0.1:8080");
    // mC branches off the first model: the parent chain says vllm, not the
    // file-order-last model (mistral).
    expect(byTotal.get(300)?.provider).toBe("vllm");
    expect(byTotal.get(300)?.model).toBe("qwen3-32b");
    // A compress-span event carries its own compression model.
    expect(byTotal.get(240)?.provider).toBe("anthropic");
    expect(byTotal.get(240)?.model).toBe("claude-haiku");
  });

  it("skips an unparseable partial trailing line", () => {
    expect(scanUsage(root).skipped).toBe(1);
    expect(events.every((e) => e.total !== 999)).toBe(true);
  });

  it("attributes shared fork history to the first file scanned", () => {
    const { sessions } = scanUsage(root);
    const a = sessions.find((s) => s.file.endsWith("11111111.jsonl"));
    const b = sessions.find((s) => s.file.endsWith("22222222.jsonl"));
    expect(a?.events).toBe(5);
    expect(a?.total).toBe(2280);
    expect(b?.events).toBe(1);
    expect(b?.total).toBe(20);
  });

  it("returns an empty result for a missing root", () => {
    const { events, files, skipped } = scanUsage(join(root, "does-not-exist"));
    expect(events).toHaveLength(0);
    expect(files).toBe(0);
    expect(skipped).toBe(0);
  });
});

// --- canonical identity -----------------------------------------------------

describe("canonical identity", () => {
  it("folds the local llama.cpp server names", () => {
    expect(canonicalProvider("llama.cpp")).toBe("local-llamacpp");
    expect(canonicalProvider("llama-server=http://127.0.0.1:8080")).toBe("local-llamacpp");
    expect(canonicalProvider("crossbar-llamacpp-127-0-0-1-8080")).toBe("local-llamacpp");
  });

  it("leaves other providers alone", () => {
    expect(canonicalProvider("omni")).toBe("omni");
    expect(canonicalProvider("openai-codex")).toBe("openai-codex");
    expect(canonicalProvider("vllm")).toBe("vllm");
  });

  it("folds model case, quant suffix, and -GGUF infix", () => {
    expect(canonicalModel("unsloth/Qwen3.8-27B-GGUF:Q4_K_XL")).toBe("unsloth/qwen3.8-27b");
    expect(canonicalModel("unsloth/qwen3.8-27b")).toBe("unsloth/qwen3.8-27b");
    expect(canonicalModel("unsloth/deepseek-v4-flash-0731-GGUF:IQ2_XXS")).toBe("unsloth/deepseek-v4-flash-0731");
  });

  it("leaves unknown model names alone", () => {
    expect(canonicalModel("gpt-5.6-luna")).toBe("gpt-5.6-luna");
    expect(canonicalModel("mistral-large")).toBe("mistral-large");
  });
});

// --- buckets and windows -----------------------------------------------------

describe("bucket keys", () => {
  const ts = Date.parse("2026-09-15T12:00:00.000Z");

  it("day and month at UTC", () => {
    expect(bucketKeyFor(ts, "day", 0)).toBe("2026-09-15");
    expect(bucketKeyFor(ts, "month", 0)).toBe("2026-09");
  });

  it("ISO week", () => {
    expect(bucketKeyFor(ts, "week", 0)).toBe("2026-W38");
    // Sunday of the same week.
    expect(bucketKeyFor(Date.parse("2026-09-20T23:00:00.000Z"), "week", 0)).toBe("2026-W38");
    // Monday of the next week.
    expect(bucketKeyFor(Date.parse("2026-09-21T01:00:00.000Z"), "week", 0)).toBe("2026-W39");
  });

  it("ISO week crosses the year boundary on the Thursday", () => {
    expect(bucketKeyFor(Date.parse("2026-01-04T23:00:00.000Z"), "week", 0)).toBe("2026-W01");
    expect(bucketKeyFor(Date.parse("2025-12-29T01:00:00.000Z"), "week", 0)).toBe("2026-W01");
    expect(bucketKeyFor(Date.parse("2025-12-28T01:00:00.000Z"), "week", 0)).toBe("2025-W52");
  });

  it("honors the UTC offset", () => {
    // 12:00Z is 17:00 same day at UTC+5, 00:00 same day at UTC-12.
    expect(bucketKeyFor(ts, "day", 300)).toBe("2026-09-15");
    expect(bucketKeyFor(ts, "day", -720)).toBe("2026-09-15");
    // 12:00Z is 01:00 the next day at UTC+14.
    expect(bucketKeyFor(ts, "day", 840)).toBe("2026-09-16");
  });
});

describe("windows", () => {
  const now = Date.parse("2026-09-15T12:00:00.000Z");

  it("the cutoff is the start of the local day N-1 days ago", () => {
    expect(windowStartFor("7d", now, 0)).toBe(Date.parse("2026-09-09T00:00:00.000Z"));
    expect(windowStartFor("30d", now, 0)).toBe(Date.parse("2026-08-17T00:00:00.000Z"));
    expect(windowStartFor("all", now, 0)).toBe(0);
  });

  it("the cutoff follows the offset", () => {
    // At UTC-12, 12:00Z is local midnight of 2026-09-15, so the 30d start
    // is local midnight of 2026-08-17: 2026-08-17T12:00Z.
    expect(windowStartFor("30d", now, -720)).toBe(Date.parse("2026-08-17T12:00:00.000Z"));
  });

  it("month filter is calendar-based", () => {
    expect(inMonthFor(Date.parse("2026-09-30T23:59:00.000Z"), "2026-09", 0)).toBe(true);
    expect(inMonthFor(Date.parse("2026-10-01T00:00:00.000Z"), "2026-09", 0)).toBe(false);
  });
});

// --- aggregate ----------------------------------------------------------------

describe("aggregate", () => {
  it("sums all events with the all-time window", () => {
    const report = aggregate(events, { ...emptyReportOptions(), window: "all" }, nowSep16);
    expect(report.events).toBe(9);
    expect(report.total.total).toBe(2900);
    expect(report.total.cost).toBeCloseTo(0.0965, 10);
    expect(report.total.input).toBe(1325);
    expect(report.total.cacheRead).toBe(200);
    expect(report.total.cacheWrite).toBe(100);
    expect(report.total.output).toBe(625);
    expect(report.total.reasoning).toBe(50);
  });

  it("the 30d window excludes older months", () => {
    // now is after the fork (09-20) and before the October session.
    const now = Date.parse("2026-09-21T12:00:00.000Z");
    const report = aggregate(events, { ...emptyReportOptions(), window: "30d" }, now);
    expect(report.events).toBe(6);
    expect(report.total.total).toBe(2300);
  });

  it("the month filter overrides the window", () => {
    const report = aggregate(events, { ...emptyReportOptions(), window: "7d", month: "2026-10" }, nowSep16);
    expect(report.total.total).toBe(600);
  });

  it("groups by provider or model only", () => {
    const byProvider = aggregate(events, { ...emptyReportOptions(), window: "all", groupBy: "provider" }, nowSep16);
    expect(byProvider.rows.every((r) => r.model === "")).toBe(true);
    const providers = new Set(byProvider.rows.map((r) => r.provider));
    expect(providers.has("local-llamacpp")).toBe(true);
    expect(providers.has("openai-codex")).toBe(true);
    expect(providers.has("vllm")).toBe(true);
    expect(providers.has("mistral")).toBe(true);
    expect(providers.has("anthropic")).toBe(true);

    const byModel = aggregate(events, { ...emptyReportOptions(), window: "all", groupBy: "model" }, nowSep16);
    expect(byModel.rows.every((r) => r.provider === "")).toBe(true);
  });

  it("folds the local server variants into one row with both raw pairs", () => {
    const report = aggregate(events, { ...emptyReportOptions(), window: "all", groupBy: "provider" }, nowSep16);
    const row = report.rows.find((r) => r.provider === "local-llamacpp" && r.bucket === "2026-W38");
    expect(row?.counts.total).toBe(2040);
    expect(row?.raw).toContainEqual({ provider: "llama.cpp", model: "unsloth/Qwen3.8-27B-GGUF:Q4_K_XL" });
    expect(row?.raw).toContainEqual({ provider: "llama-server=http://127.0.0.1:8080", model: "unsloth/qwen3.8-27b" });
  });

  it("sorts by tokens or cost descending", () => {
    const byTokens = aggregate(events, { ...emptyReportOptions(), window: "all", sort: "tokens" }, nowSep16);
    for (let i = 1; i < byTokens.rows.length; i++) {
      expect(byTokens.rows[i].counts.total).toBeLessThanOrEqual(byTokens.rows[i - 1].counts.total);
    }
    const byCost = aggregate(events, { ...emptyReportOptions(), window: "all", sort: "cost" }, nowSep16);
    for (let i = 1; i < byCost.rows.length; i++) {
      expect(byCost.rows[i].counts.cost).toBeLessThanOrEqual(byCost.rows[i - 1].counts.cost);
    }
  });

  it("drops zero-only events but keeps zero-cost work", () => {
    const evs: UsageEvent[] = [
      { ts: nowSep16, provider: "p", model: "m", input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0, cost: 0 },
      { ts: nowSep16, provider: "p", model: "m", input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 15, cost: 0 },
    ];
    const report = aggregate(evs, { ...emptyReportOptions(), window: "all" }, nowSep16);
    expect(report.events).toBe(1);
    expect(report.total.total).toBe(15);
  });

  it("filters by provider and model substring", () => {
    const provider = aggregate(events, { ...emptyReportOptions(), window: "all", provider: "openai-codex" }, nowSep16);
    expect(provider.total.total).toBe(20);
    const model = aggregate(events, { ...emptyReportOptions(), window: "all", model: "gpt-5.6" }, nowSep16);
    expect(model.total.total).toBe(20);
  });
});

// --- rendering -----------------------------------------------------------------

describe("render", () => {
  // Computed per test: the fixture events exist only after beforeAll.
  const report = () => aggregate(events, { ...emptyReportOptions(), window: "all" }, nowSep16);

  it("compact numbers stay exact under 10k and shrink above", () => {
    expect(fmtNum(0)).toBe("0");
    expect(fmtNum(9999)).toBe("9999");
    expect(fmtNum(10_000)).toBe("10k");
    expect(fmtNum(12_500)).toBe("12.5k");
    expect(fmtNum(999_500)).toBe("1M");
    expect(fmtNum(949_015_512)).toBe("949M");
    expect(fmtNum(2_002_375_040)).toBe("2B");
    expect(fmtNum(2_000_000_000_000)).toBe("2T");
  });

  it("renders the header, rows, and grand total", () => {
    const text = renderReportText(report());
    expect(text).toContain("pi usage report");
    expect(text).toContain("all time");
    expect(text).toContain("2,900");
    expect(text).toContain("TOTAL");
    expect(text).toContain("local-llamacpp");
    expect(text).toContain("$0.10");
  });

  it("compact columns merge cache read and write", () => {
    const text = renderReportText(report(), { columns: "compact" });
    expect(text).toContain("Cache");
    expect(text).not.toContain("CacheR");
    // 200 read + 100 write = 300
    expect(text).toContain("300");
  });
});
