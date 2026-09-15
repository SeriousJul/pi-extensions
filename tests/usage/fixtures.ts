/**
 * Shared fixture for the usage tests: three synthetic session files in a
 * temp directory.
 *
 * a.jsonl: assistant, model change, second assistant, a tool result with
 *         nested LLM usage, and a compaction with a retained tail.
 * b.jsonl: a fork of a.jsonl (byte-identical copied lines) plus one new
 *         event on openai-codex.
 * c.jsonl: a branch back to the first model, plus an unparseable partial
 *         trailing line.
 *
 * Totals: a = 2,040 tokens (4 events), b = 20 (1 new event), c = 600
 * (3 events). Grand total 2,660 tokens, 0.0935 cost, 8 events.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const L = (obj: unknown) => JSON.stringify(obj);

export const mc1Line = L({
  type: "model_change",
  id: "aaaa1111",
  parentId: null,
  timestamp: "2026-09-15T08:00:01.000Z",
  provider: "llama.cpp",
  modelId: "unsloth/Qwen3.8-27B-GGUF:Q4_K_XL",
});
export const m1Line = L({
  type: "message",
  id: "aaaa1112",
  parentId: "aaaa1111",
  timestamp: "2026-09-15T09:00:00.000Z",
  message: {
    role: "assistant",
    provider: "llama.cpp",
    model: "unsloth/Qwen3.8-27B-GGUF:Q4_K_XL",
    timestamp: 1757946000000,
    usage: { input: 1000, output: 500, cacheRead: 200, cacheWrite: 100, reasoning: 50, totalTokens: 1850, cost: { total: 0.02 } },
  },
});

export function buildFixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "usage-fixture-"));
  const dirA = join(root, "work-a");
  const dirC = join(root, "work-c");
  mkdirSync(dirA, { recursive: true });
  mkdirSync(dirC, { recursive: true });

  const aLines = [
    L({ type: "session", id: "sess_aaa1", version: 3, timestamp: "2026-09-15T08:00:00.000Z", cwd: "/work/a" }),
    mc1Line,
    m1Line,
    L({
      type: "model_change",
      id: "aaaa1113",
      parentId: "aaaa1112",
      timestamp: "2026-09-15T09:30:00.000Z",
      provider: "llama-server=http://127.0.0.1:8080",
      modelId: "unsloth/qwen3.8-27b",
    }),
    L({
      type: "message",
      id: "aaaa1114",
      parentId: "aaaa1113",
      timestamp: "2026-09-16T10:00:00.000Z",
      message: {
        role: "assistant",
        provider: "llama-server=http://127.0.0.1:8080",
        model: "unsloth/qwen3.8-27b",
        usage: { input: 100, output: 65, totalTokens: 165, cost: { total: 0.01 } },
      },
    }),
    // A tool result that did nested LLM work: no provider or model of its
    // own; its parent chain reaches mc1.
    L({
      type: "message",
      id: "aaaa1115",
      parentId: "aaaa1112",
      timestamp: "2026-09-16T10:30:00.000Z",
      message: { role: "toolResult", toolName: "web_search", usage: { input: 5, output: 5, totalTokens: 10, cost: { total: 0.0005 } } },
    }),
    // A compaction entry: its own usage is counted; the retained tail is a
    // copy of earlier messages and must not be counted again.
    L({
      type: "compaction",
      id: "aaaa1116",
      parentId: "aaaa1114",
      timestamp: "2026-09-16T11:00:00.000Z",
      usage: { input: 10, output: 5, totalTokens: 15, cost: { total: 0.001 } },
      retainedTail: [{ message: { role: "assistant", usage: { totalTokens: 777, cost: { total: 0.777 } } } }],
    }),
  ];
  writeFileSync(join(dirA, "2026-09-15_11111111.jsonl"), aLines.join("\n") + "\n");

  const bLines = [
    L({ type: "session", id: "sess_bbb1", version: 3, parentSession: "sess_aaa1", timestamp: "2026-09-20T12:00:00.000Z", cwd: "/work/a" }),
    mc1Line,
    m1Line,
    L({ type: "model_change", id: "bbbb3331", parentId: null, timestamp: "2026-09-20T12:00:00.000Z", provider: "openai-codex", modelId: "gpt-5.6-luna" }),
    L({
      type: "message",
      id: "bbbb3332",
      parentId: "bbbb3331",
      timestamp: "2026-09-20T12:05:00.000Z",
      message: { role: "assistant", provider: "openai-codex", model: "gpt-5.6-luna", usage: { input: 10, output: 10, totalTokens: 20, cost: { total: 0.05 } } },
    }),
  ];
  writeFileSync(join(dirA, "2026-09-20_22222222.jsonl"), bLines.join("\n") + "\n");

  // c.jsonl: a branch back to the first model. mC parents off the first
  // message's branch, so the file-order-last model_change (mistral) is the
  // wrong attribution; the parent chain says vllm. Mid-day UTC so the
  // dates hold in every timezone.
  const cLines = [
    L({ type: "session", id: "sess_ccc1", version: 3, timestamp: "2026-10-02T00:00:00.000Z", cwd: "/work/c" }),
    L({ type: "model_change", id: "cc000001", parentId: null, timestamp: "2026-10-02T00:00:01.000Z", provider: "vllm", modelId: "qwen3-32b" }),
    L({
      type: "message",
      id: "cc000002",
      parentId: "cc000001",
      timestamp: "2026-10-02T01:00:00.000Z",
      message: { role: "assistant", provider: "vllm", model: "qwen3-32b", usage: { totalTokens: 100, cost: { total: 0.002 } } },
    }),
    L({ type: "model_change", id: "cc000003", parentId: "cc000002", timestamp: "2026-10-02T02:00:00.000Z", provider: "mistral", modelId: "mistral-large" }),
    L({
      type: "message",
      id: "cc000004",
      parentId: "cc000003",
      timestamp: "2026-10-02T03:00:00.000Z",
      message: { role: "assistant", provider: "mistral", model: "mistral-large", usage: { totalTokens: 200, cost: { total: 0.004 } } },
    }),
    L({
      type: "message",
      id: "cc000005",
      parentId: "cc000002",
      timestamp: "2026-10-02T04:00:00.000Z",
      message: { role: "assistant", provider: "vllm", model: "qwen3-32b", usage: { totalTokens: 300, cost: { total: 0.006 } } },
    }),
  ];
  // A partial trailing line, as a live session would have mid-write.
  writeFileSync(join(dirC, "2026-10-02_33333333.jsonl"), cLines.join("\n") + "\n" + '{"type":"message","id":"cc000006","parentId":"cc000002","message":{"role":"assistant","usage":{"totalTokens":999,"cost":{"total":0.999}');
  return root;
}
