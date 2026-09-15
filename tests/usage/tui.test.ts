/**
 * TUI tests for the usage report: drive the component with key events and
 * assert on the rendered lines and the state the keys produce. The theme
 * and TUI are fakes; the data is the shared fixture.
 */
import { rmSync } from "node:fs";
import type { TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { emptyReportOptions } from "../../extensions/usage/lib/aggregate.ts";
import { scanUsage } from "../../extensions/usage/lib/scan.ts";
import type { UsageEvent } from "../../extensions/usage/lib/types.ts";
import { createUsageTui } from "../../extensions/usage/tui.ts";
import { buildFixtureRoot } from "./fixtures.ts";

const fakeTheme = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s } as unknown as Theme;
const fakeTui = { requestRender: () => {}, terminal: { rows: 40, columns: 120 } } as unknown as TUI;

// The fixture events sit at fixed 2026 dates, so the window starts at "all".
const ALL = { ...emptyReportOptions(), window: "all" as const };

let root = "";
let events: UsageEvent[] = [];
beforeAll(() => {
  root = buildFixtureRoot();
  events = scanUsage(root).events;
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

interface Rig {
  component: ReturnType<typeof createUsageTui>;
  settled: Promise<void>;
  loadCount: () => number;
  closed: { called: boolean };
  render: (w?: number) => string[];
}

function makeTui(loadImpl?: () => Promise<UsageEvent[]>): Rig {
  let loads = 0;
  let resolveEvents!: (ev: UsageEvent[]) => void;
  const pending = new Promise<UsageEvent[]>((res) => (resolveEvents = res));
  const closed = { called: false };
  const component = createUsageTui({
    tui: fakeTui,
    theme: fakeTheme,
    initial: { ...ALL },
    load: () => {
      loads++;
      return loadImpl ? loadImpl() : pending;
    },
    viewport: () => 10,
    close: () => {
      closed.called = true;
    },
  });
  const settled = (async () => {
    resolveEvents(events);
    await new Promise((r) => setTimeout(r, 0));
  })();
  return {
    component,
    settled,
    loadCount: () => loads,
    closed,
    render: (w = 120) => component.render(w),
  };
}

const press = (rig: Rig, data: string) => rig.component.handleInput(data);
const totalLine = (lines: string[]) => lines.find((l) => l.startsWith("  TOTAL")) ?? "";
const cursorLine = (lines: string[]) => (lines.find((l) => l.startsWith("▶")) ?? "").slice(2);

describe("usage TUI", () => {
  it("renders the report after the scan settles", async () => {
    const rig = makeTui();
    expect(rig.render()).toContain("scanning session files...");
    await rig.settled;
    const lines = rig.render();
    expect(lines[0]).toBe("pi usage");
    const text = lines.join("\n");
    expect(text).toContain("all time");
    expect(text).toContain("8 events");
    expect(totalLine(lines)).toContain("2660");
    expect(lines[lines.length - 1]).toContain("esc close");
  });

  it("b cycles the bucket to day labels", async () => {
    const rig = makeTui();
    await rig.settled;
    press(rig, "b");
    const text = rig.render().join("\n");
    expect(text).toContain("b day");
    expect(text).toContain("2026-09-15");
  });

  it("g cycles the group by axis", async () => {
    const rig = makeTui();
    await rig.settled;
    press(rig, "g");
    const text = rig.render().join("\n");
    expect(text).toContain("g provider");
    expect(text).not.toContain("Model");
    press(rig, "g");
    expect(rig.render().join("\n")).toContain("g model");
  });

  it("s sorts by tokens and the biggest row comes first", async () => {
    const rig = makeTui();
    await rig.settled;
    press(rig, "s");
    expect(cursorLine(rig.render())).toContain("2040");
  });

  it("d shows the raw pairs behind the folded row", async () => {
    const rig = makeTui();
    await rig.settled;
    press(rig, "d");
    const text = rig.render().join("\n");
    expect(text).toContain("llama.cpp / unsloth/Qwen3.8-27B-GGUF:Q4_K_XL");
    expect(text).toContain("llama-server=http://127.0.0.1:8080 / unsloth/qwen3.8-27b");
  });

  it("j and k move the cursor", async () => {
    const rig = makeTui();
    await rig.settled;
    const first = cursorLine(rig.render());
    press(rig, "j");
    expect(cursorLine(rig.render())).not.toBe(first);
    press(rig, "k");
    expect(cursorLine(rig.render())).toBe(first);
  });

  it("p cycles the provider filter", async () => {
    const rig = makeTui();
    await rig.settled;
    press(rig, "p");
    const lines = rig.render();
    expect(lines.join("\n")).toContain("p local-llamacpp");
    expect(totalLine(lines)).toContain("2040");
  });

  it("m filters models by typed substring and clears on backspace", async () => {
    const rig = makeTui();
    await rig.settled;
    press(rig, "m");
    for (const ch of "qwen") press(rig, ch);
    expect(totalLine(rig.render())).toContain("2440");
    for (let i = 0; i < 4; i++) press(rig, "\x7f");
    press(rig, "\x1b");
    expect(totalLine(rig.render())).toContain("2660");
  });

  it("r rescans", async () => {
    const rig = makeTui();
    await rig.settled;
    expect(rig.loadCount()).toBe(1);
    press(rig, "r");
    await new Promise((r) => setTimeout(r, 0));
    expect(rig.loadCount()).toBe(2);
  });

  it("esc closes the view", async () => {
    const rig = makeTui();
    await rig.settled;
    press(rig, "\x1b");
    expect(rig.closed.called).toBe(true);
  });

  it("shows an error line when the scan fails", async () => {
    const component = createUsageTui({
      tui: fakeTui,
      theme: fakeTheme,
      initial: { ...ALL },
      load: () => Promise.reject(new Error("boom")),
      viewport: () => 10,
      close: () => {},
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(component.render(120).join("\n")).toContain("scan failed: boom");
  });
});
