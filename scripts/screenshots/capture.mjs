#!/usr/bin/env node
/**
 * The docs screenshot pipeline (issue #73, ADR 0017).
 *
 * Regenerates every docs screenshot from committed fixtures: one command,
 * deterministic bytes. Off-screen views render the exact component the
 * extension's /command would mount; real-terminal captures run real pi or
 * the real CLIs in a pseudo-terminal at the pinned grid, with the machine
 * mocked (local model server, local Gist API) so nothing leaves the box.
 *
 *   node scripts/screenshots/capture.mjs            # all captures
 *   node scripts/screenshots/capture.mjs <id>...    # a subset, by id
 *
 * CI runs this and fails when any committed PNG drifts.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { applyEnvPins, LOOK, WORK_ROOT } from "./look.mjs";
import { CAPTURES } from "./definitions.mjs";
import { EXPECTED_LINES } from "./expected.mjs";
import { captureComponentBytes } from "./offscreen.mjs";
import { renderScreenToPng, screenToText } from "./render-png.mjs";
import { captureTerminal } from "./terminal-capture.mjs";
import { startMockModelServer } from "./mock-model.mjs";
import { startMockGistServer } from "./mock-gist.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Assert the settled screen shows every expected line (spec seam 3).
 * Without this, a live pty capture that loses its content would be
 * re-blessed into the goldens by the very command meant to fix them.
 */
async function assertExpectedLines(def, bytes) {
	const expected = EXPECTED_LINES[def.id] ?? [];
	if (expected.length === 0) return;
	const rows = (await screenToText(bytes, { cols: LOOK.cols, rows: LOOK.rows })).map((line) => line.trim());
	const missing = expected.filter((line) => !rows.some((row) => row.includes(line.trim())));
	if (missing.length > 0) {
		throw new Error(`missing expected content: ${missing.map((l) => JSON.stringify(l)).join(" ")}`);
	}
}

async function captureOffscreen(def) {
	const bytes = await captureComponentBytes(def.build, { cols: LOOK.cols, rows: LOOK.rows });
	await assertExpectedLines(def, bytes);
	return renderScreenToPng(bytes, LOOK);
}

async function capturePty(def, ctx) {
	const spec = await def.setup(ctx);
	const result = await captureTerminal({ ...spec, cols: LOOK.cols, rows: LOOK.rows });
	await assertExpectedLines(def, result.bytes);
	return renderScreenToPng(result.bytes, LOOK);
}

async function main() {
	applyEnvPins();
	rmSync(WORK_ROOT, { recursive: true, force: true });
	mkdirSync(WORK_ROOT, { recursive: true });

	const model = await startMockModelServer();
	const gist = await startMockGistServer();
	const ctx = {
		repoRoot,
		modelPort: model.port,
		serveGist: async (g) => {
			gist.register(g);
			return { port: gist.port };
		},
	};

	const wanted = process.argv.slice(2);
	const failures = [];
	for (const def of CAPTURES) {
		if (wanted.length > 0 && !wanted.includes(def.id)) continue;
		const started = Date.now();
		try {
			const png = def.kind === "offscreen" ? await captureOffscreen(def) : await capturePty(def, ctx);
			const out = join(repoRoot, def.out);
			mkdirSync(dirname(out), { recursive: true });
			writeFileSync(out, png);
			console.log(`ok   ${def.id}  ${png.length} bytes  ${Date.now() - started}ms`);
		} catch (err) {
			failures.push({ id: def.id, err });
			console.error(`FAIL ${def.id}: ${err instanceof Error ? err.message : err}`);
		}
	}

	await model.close();
	await gist.close();
	if (failures.length > 0) {
		console.error(`\n${failures.length} of ${CAPTURES.length} captures failed`);
		process.exit(1);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
