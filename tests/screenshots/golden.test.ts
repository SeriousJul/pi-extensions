/**
 * Golden tests for the docs screenshot pipeline (issue #73, ADR 0017).
 *
 * Every "fast" capture (all off-screen views plus the two CLI captures)
 * is re-rendered in the test and compared byte-for-byte with the PNG
 * committed to the repository. The same assertions plus the live-pi
 * captures run in the CI screenshots job.
 *
 * The text assertions pin the content of each capture, so a silently
 * broken view cannot be re-blessed into the goldens without a visible
 * diff in the test output.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyEnvPins, LOOK, WORK_ROOT } from "../../scripts/screenshots/look.mjs";
import { CAPTURES, type CaptureContext, type CaptureDefinition } from "../../scripts/screenshots/definitions.mjs";
import { captureComponentBytes } from "../../scripts/screenshots/offscreen.mjs";
import { renderScreenToPng, screenToText } from "../../scripts/screenshots/render-png.mjs";
import { captureTerminal } from "../../scripts/screenshots/terminal-capture.mjs";
import { startMockGistServer, type MockGistServer } from "../../scripts/screenshots/mock-gist.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");

const captures: CaptureDefinition[] = CAPTURES;
const fastCaptures = captures.filter((def) => def.kind === "offscreen" || def.fast === true);

/** The lines every capture must show (compared trimmed, in any order). */
const EXPECTED_LINES: Record<string, string[]> = {
	"quota-detail": [
		"ChatGPT plan quota",
		"Plan: plus",
		"Account: julian@example.com",
		"5h  42%   resets 19:00 (in 5h)",
		"7d  18%   resets Thu 14:00 (in 7d)",
		"Fetched: 13:56:00 (4m ago)",
		"Press Enter or Esc to close",
	],
	"quota-footer": ["GPT 5h 42% · 7d 18%"],
	"usage-tui": [
		"pi usage",
		"b week   w all   g provider+model   s time   c full   p none   m none",
		"9 events · all time",
		"TOTAL                                 1325      200      100      625       50     2900    $0.10",
	],
	"usage-cli": [
		"2026-09 · week · provider+model · sort: time · 6 events",
		"TOTAL                                      1,325          300          625        2,300        $0.08",
	],
	"initial-context": [
		"initial context",
		"ctx: 1.3K (1.0%) - uses: 30d",
		"1,272  100.0%  1.0%",
		"375.0/u",
	],
	tools: [
		"Tool Configuration",
		"Tag = extension or SDK origin. No tag = built-in.",
		"→ read                     enabled",
		"resource_toggle (index)  enabled",
		"web_search (web-search)  enabled",
	],
	resources: [
		"pi resources",
		"Extensions",
		">  [x] codegraph  global  /home/julian/.pi/agent/extensions/codegraph/index.",
		"[ ] usage  global  /home/julian/.pi/agent/extensions/usage/index.ts",
		"[x] lint-gate  project  /home/julian/acme/.pi/extensions/lint-gate/index.",
		"Skills",
		"Themes",
	],
	"sync-view": [
		"pi sync",
		"pi sync status (gist 9f2c41ab)",
		"ahead 0, behind 0",
		"in sync",
	],
	"sync-status": ["pi sync status (gist 9f2c41ab)", "ahead 0, behind 0", "in sync"],
	"pruning-settings": [
		"pruning: enabled=true, minResultTokens=1000, protectCurrentTurn=true",
		"state: no outputs pruned yet; last gate: none",
	],
	"compress-status": ["3 spans, 12.4k saved"],
};

/** PNG header: 8-byte signature, IHDR length, "IHDR", then width and height. */
function pngSize(png: Buffer): { width: number; height: number } {
	return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

describe("docs screenshot pipeline (ADR 0017)", () => {
	let gist: MockGistServer | undefined;

	beforeAll(async () => {
		process.env.TZ = "UTC";
		applyEnvPins();
		rmSync(WORK_ROOT, { recursive: true, force: true });
		mkdirSync(WORK_ROOT, { recursive: true });
		gist = await startMockGistServer();
	}, 240_000);

	afterAll(async () => {
		await gist?.close();
	}, 240_000);

	/** The raw terminal bytes of one capture, before the PNG round trip. */
	async function captureBytes(def: CaptureDefinition): Promise<string> {
		const ctx: CaptureContext = {
			repoRoot,
			modelPort: 0,
			serveGist: async (g) => {
				gist?.register(g);
				return { port: gist?.port ?? 0 };
			},
		};
		if (def.kind === "offscreen") {
			return captureComponentBytes(def.build as (tui: unknown) => unknown, {
				cols: LOOK.cols,
				rows: LOOK.rows,
			});
		}
		const spec = await def.setup?.(ctx);
		if (!spec) throw new Error(`${def.id}: pty capture has no setup`);
		const result = await captureTerminal({
			...spec,
			cols: LOOK.cols,
			rows: LOOK.rows,
		});
		return result.bytes;
	}

	it("commits one PNG per capture at the pinned 780x510 size", () => {
		for (const def of captures) {
			const png = readFileSync(join(repoRoot, def.out));
			const { width, height } = pngSize(png);
			expect(width, `${def.id} width`).toBe(780);
			expect(height, `${def.id} height`).toBe(510);
		}
	});

	for (const def of fastCaptures) {
		it(`re-renders ${def.id} byte-identical to the committed PNG`, { timeout: 120_000 }, async () => {
			const rendered = Buffer.from(await renderScreenToPng(await captureBytes(def), LOOK));
			const committed = readFileSync(join(repoRoot, def.out));
			expect(
				rendered.equals(committed),
				`${def.id}: re-rendered PNG differs from the committed PNG; run 'npm run docs:screenshots'`,
			).toBe(true);
		});

		it(`shows the expected content in ${def.id}`, { timeout: 120_000 }, async () => {
			const text = (await screenToText(await captureBytes(def), { cols: LOOK.cols, rows: LOOK.rows })).map(
				(line) => line.trim(),
			);
			for (const line of EXPECTED_LINES[def.id] ?? []) {
				expect(text.some((t) => t.includes(line.trim())), `${def.id}: missing expected line ${JSON.stringify(line)}`).toBe(true);
			}
		});
	}
});
