/**
 * Renderer-level golden tests (issue #73, spec seam 1, ADR 0017).
 *
 * Two fixed ANSI screens, committed as .ansi text files next to this test,
 * are rendered through the full pipeline (xterm-headless grid -> SVG ->
 * resvg with the committed fonts) and compared byte-for-byte with the
 * committed .png goldens. The plain screen pins the baseline; the styled
 * screen exercises every style the renderer must carry: palette colors,
 * truecolor, bold, dim, and underline. These pin the renderer contract
 * itself, independent of any capture. To re-bless a golden, render the
 * same input with renderScreenToPng and overwrite the .png.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LOOK } from "../../scripts/screenshots/look.mjs";
import { renderScreenToPng } from "../../scripts/screenshots/render-png.mjs";

const here = dirname(fileURLToPath(import.meta.url));

for (const name of ["plain", "styled"]) {
	describe(`renderer golden: ${name}`, () => {
		it(`renders ${name}.ansi byte-identical to the committed ${name}.png`, { timeout: 120_000 }, async () => {
			// The .ansi files are ASCII, so the bytes and the string are the same.
			const input = readFileSync(join(here, "renderer", `${name}.ansi`)).toString("utf8");
			const rendered = Buffer.from(await renderScreenToPng(input, LOOK));
			const committed = readFileSync(join(here, "renderer", `${name}.png`));
			expect(
				rendered.equals(committed),
				`${name}: the renderer's output drifted from the committed golden`,
			).toBe(true);
		});
	});
}
