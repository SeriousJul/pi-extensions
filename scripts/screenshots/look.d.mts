/** The pinned terminal look for every docs screenshot (ADR 0017). */
export interface Look {
	/** The terminal grid every screenshot renders into. */
	cols: number;
	rows: number;
	fontFamily: string;
	fontFiles: string[];
	fontSizePx: number;
	cellW: number;
	cellH: number;
	baseline: number;
	/** pi's dark theme export.pageBg: the terminal background. */
	background: string;
	/** pi's dark theme "text" color: the default foreground. */
	defaultFg: string;
	/** The default background (cells with no explicit bg). */
	defaultBg: string;
	/** PNG pixel size of one screenshot. */
	widthPx: number;
	heightPx: number;
}

/** The exact pinned look; every render uses these values. */
export declare const LOOK: Look;

/** The theme the user sees by default: pi's bundled dark theme file. */
export declare function darkThemePath(): string;

/**
 * Environment pins every capture run with: TZ=UTC for clock-derived
 * strings, FORCE_COLOR=3 for truecolor SGR outside a TTY.
 */
export declare function applyEnvPins(env?: Record<string, string | undefined>): void;

/**
 * The fixed working root. Captures never use mktemp: a fixed path keeps
 * fixture-derived strings byte-identical across runs.
 */
export declare const WORK_ROOT: string;
