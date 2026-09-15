/**
 * Usage: token and cost reporting across all pi sessions.
 *
 * - /usage command: interactive TUI in the terminal, text report in
 *   headless modes (a notify record in RPC, the console in print mode).
 * - usage_report tool: lets the agent answer usage questions. With no
 *   arguments it queues /usage so the user sees the TUI; with arguments it
 *   returns the report as text.
 */
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { aggregate, emptyReportOptions } from "./lib/aggregate.ts";
import { defaultSessionsRoot, scanUsage } from "./lib/scan.ts";
import { renderReportText } from "./lib/render.ts";
import { createUsageTui } from "./tui.ts";
import type { ReportOptions } from "./lib/types.ts";

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("usage", {
    description: "Show LLM token and cost usage across all sessions",
    handler: async (_args, ctx) => {
      if (ctx.hasUI && ctx.mode === "tui") {
        await ctx.ui.custom((tui, theme, _keybindings, done) => {
          // The report view: title, knobs, event count, blank, table,
          // optional detail block, blank, legend. 12 lines of overhead
          // covers pi's own chrome (messages, footer, editor row).
          const viewport = () => Math.max(8, Math.min(tui.terminal.rows - 12, 24));
          return createUsageTui({
            tui,
            theme,
            initial: emptyReportOptions(),
            load: () => Promise.resolve(scanUsage(defaultSessionsRoot()).events),
            viewport,
            close: () => done(undefined),
          });
        });
        return;
      }

      const { events } = await scanUsage(defaultSessionsRoot());
      const report = aggregate(events, emptyReportOptions());
      const text = renderReportText(report);
      if (ctx.hasUI && ctx.mode === "rpc") {
        ctx.ui.notify(text, "info");
      } else {
        console.log(text);
      }
    },
  });

  pi.registerTool({
    name: "usage_report",
    label: "Usage Report",
    description:
      "Report LLM token and cost usage across all pi sessions. With no arguments it opens the interactive usage report in the terminal for the user to explore. With arguments it returns the report as text.",
    promptSnippet: "Report pi LLM token and cost usage across sessions",
    parameters: Type.Object({
      bucket: Type.Optional(Type.Union([Type.Literal("day"), Type.Literal("week"), Type.Literal("month")])),
      window: Type.Optional(
        Type.Union([Type.Literal("7d"), Type.Literal("30d"), Type.Literal("90d"), Type.Literal("1y"), Type.Literal("all")]),
      ),
      group: Type.Optional(Type.Union([Type.Literal("provider"), Type.Literal("model")])),
    }),
    promptGuidelines: [
      "Use usage_report when the user asks how many tokens, cache tokens, or dollars pi sessions used, by day, week, month, provider, or model.",
    ],
    async execute(_toolCallId, params) {
      const hasArgs = params.bucket !== undefined || params.window !== undefined || params.group !== undefined;
      if (!hasArgs) {
        pi.sendUserMessage("/usage", { deliverAs: "followUp" });
        return {
          content: [{ type: "text", text: "Opened the interactive usage report in the terminal." }],
          details: {},
        };
      }
      const options: ReportOptions = {
        ...emptyReportOptions(),
        ...(params.bucket !== undefined ? { bucket: params.bucket } : {}),
        ...(params.window !== undefined ? { window: params.window } : {}),
        ...(params.group !== undefined ? { groupBy: params.group } : {}),
      };
      const { events } = await scanUsage(defaultSessionsRoot());
      const text = renderReportText(aggregate(events, options));
      return { content: [{ type: "text", text }], details: {} };
    },
  });
}
