/**
 * Background jobs display module: the bash_bg tool row.
 *
 * Pure and engine-free: it knows no theme object and no pi API. The call
 * line reuses the built-in bash line shape (`$ <command>`) with no
 * background marker, per ADR 0024. The extension wiring (index.ts) applies
 * the theme and returns the Text component, so the exact line is unit
 * tested here.
 */

/** The least of a theme the call line needs. The real Theme satisfies it
 * structurally, so the wiring passes it through without a cast. */
export interface CallLinePainter {
	fg: (color: "toolTitle" | "toolOutput", text: string) => string;
	bold: (text: string) => string;
}

/**
 * The bash_bg tool row as one styled line: `$ <command>` in bold toolTitle,
 * the same shape as the built-in bash row. A missing or empty command
 * (arguments still streaming in) paints as `$ ...` with the ellipsis in
 * toolOutput, the built-in bash behavior for a missing command.
 */
export function paintBashBgCallLine(command: unknown, paint: CallLinePainter): string {
	const display =
		typeof command === "string" && command.length > 0 ? command : paint.fg("toolOutput", "...");
	return paint.fg("toolTitle", paint.bold(`$ ${display}`));
}
