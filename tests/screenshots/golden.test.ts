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
 * diff in the test output. The font test proves the committed TTFs are
 * what the renderer rasterizes, not a font the machine happens to have.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyEnvPins, LOOK, WORK_ROOT } from "../../scripts/screenshots/look.mjs";
import { CAPTURES, type CaptureContext, type CaptureDefinition } from "../../scripts/screenshots/definitions.mjs";
import { EXPECTED_LINES } from "../../scripts/screenshots/expected.mjs";
import { captureComponentBytes } from "../../scripts/screenshots/offscreen.mjs";
import {
	gridToSvg,
	renderScreenToPng,
	renderScreenToPngWithoutFontFiles,
	resvgOptions,
	screenToGrid,
	screenToText,
} from "../../scripts/screenshots/render-png.mjs";
import { captureTerminal } from "../../scripts/screenshots/terminal-capture.mjs";
import { startMockGistServer, type MockGistServer } from "../../scripts/screenshots/mock-gist.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");

const captures: CaptureDefinition[] = CAPTURES;
const fastCaptures = captures.filter((def) => def.kind === "offscreen" || def.fast === true);

/** One fixed screen the font test renders. */
const FONT_CHECK_BYTES = "\x1b[2J\x1b[HFont family check: ABCdefgh 0123456789";

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

	// The render must depend on the committed TTFs: the same screen rendered
	// without font files (system fonts disabled, so resvg falls back to its
	// built-in font) must differ, and the committed-font render must carry
	// real ink. If the committed files were silently ignored, the no-files
	// and machine-font renders would match and this test would fail.
	it("renders the pinned screen with the committed font files, not a machine font", { timeout: 120_000 }, async () => {
		const withFiles = Buffer.from(await renderScreenToPng(FONT_CHECK_BYTES, LOOK));
		const withoutFiles = Buffer.from(await renderScreenToPngWithoutFontFiles(FONT_CHECK_BYTES, LOOK));
		expect(
			withFiles.equals(withoutFiles),
			"rendered identically with and without the committed font files: the provided TTFs are not the rendered font",
		).toBe(false);
		// The committed-font render must actually draw glyphs: count the
		// non-background pixels of the rasterized SVG.
		const grid = await screenToGrid(FONT_CHECK_BYTES, { cols: LOOK.cols, rows: LOOK.rows });
		const svg = gridToSvg(grid, LOOK);
		const mod = await import("@resvg/resvg-js");
		const Resvg = mod.Resvg ?? mod.default?.Resvg;
		const pixels: Buffer = new Resvg(svg, resvgOptions(LOOK)).render().pixels;
		const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(LOOK.background.slice(i, i + 2), 16));
		let ink = 0;
		for (let i = 0; i < pixels.length; i += 4) {
			if (pixels[i] !== r || pixels[i + 1] !== g || pixels[i + 2] !== b) ink++;
		}
		expect(ink, "the pinned font drew no visible ink").toBeGreaterThan(100);
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
