/**
 * Device-local credential and state locations.
 *
 * The GitHub credential exists in two forms:
 *
 * - Managed: issued by the tool through the OAuth device flow (ADR 0007),
 *   stored as JSON in <state>/token. It carries the access token, the
 *   rolling refresh token, the obtained time, the expiry, and its origin.
 *   The tool renews it while it lives (refresh.ts) and re-runs the device
 *   flow when it dies (deviceflow.ts).
 * - Hand-written: plain text in <state>/token, or PI_SYNC_TOKEN for one
 *   run. Respected, but never managed: the tool never refreshes, rotates,
 *   or re-issues a token it did not create.
 */
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const TOKEN_ENV = "PI_SYNC_TOKEN";
export const STATE_DIR_ENV = "PI_SYNC_STATE_DIR";
export const HOME_ENV = "PI_SYNC_HOME";
export const GITHUB_BASE_URL_ENV = "PI_SYNC_GITHUB_BASE_URL";
export const TOKEN_FILE_NAME = "token";

/** The sync state directory: PI_SYNC_STATE_DIR, else <home>/.pi/sync. */
export function stateDirFor(home: string, env: NodeJS.ProcessEnv = process.env): string {
	return env[STATE_DIR_ENV] || join(home, ".pi", "sync");
}

/** The home directory sync operates on: PI_SYNC_HOME, else the OS home. */
export function homeFor(env: NodeJS.ProcessEnv = process.env): string {
	return env[HOME_ENV] || homedir();
}

/** Where the token (managed or hand-written) lives. Never part of the Snapshot. */
export function tokenPathFor(stateDir: string): string {
	return join(stateDir, TOKEN_FILE_NAME);
}

/** Where the tool stores a device-flow issued token. */
export type TokenSource = "env" | "managed-file" | "plain-file";

/** The renewable part of a managed token. */
export interface ManagedTokenData {
	refreshToken: string;
	obtainedMs: number;
	expiresMs: number;
}

/** A device-flow issued token pair, right after it is obtained. */
export interface ManagedTokenPair {
	accessToken: string;
	refreshToken: string;
	obtainedMs: number;
	expiresMs: number;
}

export interface TokenResolution {
	token?: string;
	/** Advisory line to ride with the next report (for example a loose file mode). */
	warning?: string;
	/** The exact fix to show when no usable token exists. */
	error?: string;
	/** Where the token came from. Undefined when there is none. */
	source?: TokenSource;
	/** Present only for a managed (tool-issued) token file. */
	managed?: ManagedTokenData;
}

interface ManagedTokenShape {
	v?: unknown;
	origin?: unknown;
	accessToken?: unknown;
	refreshToken?: unknown;
	obtainedMs?: unknown;
	expiresMs?: unknown;
}

/** Parse the managed (JSON) token shape. Null when the text is not one. */
export function parseManagedToken(text: string): ManagedTokenPair | null {
	let data: ManagedTokenShape;
	try {
		data = JSON.parse(text) as ManagedTokenShape;
	} catch {
		return null;
	}
	if (typeof data !== "object" || data === null) return null;
	if (
		typeof data.accessToken !== "string" ||
		data.accessToken === "" ||
		typeof data.refreshToken !== "string" ||
		data.refreshToken === "" ||
		typeof data.obtainedMs !== "number" ||
		typeof data.expiresMs !== "number"
	) {
		return null;
	}
	return { accessToken: data.accessToken, refreshToken: data.refreshToken, obtainedMs: data.obtainedMs, expiresMs: data.expiresMs };
}

/** Store a device-flow issued token owner-only. The tool owns this file. */
export async function writeManagedToken(stateDir: string, pair: ManagedTokenPair): Promise<void> {
	const path = tokenPathFor(stateDir);
	await mkdir(dirname(path), { recursive: true });
	const text = `${JSON.stringify({ v: 1, origin: "device-flow", ...pair }, null, 2)}\n`;
	await writeFile(path, text, { mode: 0o600 });
	// writeFile's mode applies only on creation; enforce it on every write.
	await chmod(path, 0o600).catch(() => undefined);
}

/**
 * Resolve the GitHub token: the environment override wins, then the token
 * file (managed JSON or hand-written plain text). `error` carries the exact
 * fix to show when neither exists.
 */
export function resolveToken(home: string, env: NodeJS.ProcessEnv = process.env): TokenResolution {
	const fromEnv = env[TOKEN_ENV];
	if (fromEnv && fromEnv.trim() !== "") return { token: fromEnv.trim(), source: "env" };

	const stateDir = stateDirFor(home, env);
	const tokenPath = tokenPathFor(stateDir);
	try {
		const stat = statSync(tokenPath);
		if (!stat.isFile()) {
			return { error: `${tokenPath} is not a regular file; write the token as plain text there or set ${TOKEN_ENV}` };
		}
		const text = readFileSync(tokenPath, "utf8").trim();
		if (text === "") {
			return { error: noTokenMessage(tokenPath) };
		}
		const warning = (stat.mode & 0o077) !== 0 ? `token file is group or world readable; run: chmod 600 ${tokenPath}` : undefined;
		const managed = parseManagedToken(text);
		if (managed) {
			return { token: managed.accessToken, warning, source: "managed-file", managed: { refreshToken: managed.refreshToken, obtainedMs: managed.obtainedMs, expiresMs: managed.expiresMs } };
		}
		return { token: text, warning, source: "plain-file" };
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			return { error: `cannot read ${tokenPath}: ${String(err)}` };
		}
		return { error: noTokenMessage(tokenPath) };
	}
}

export function noTokenMessage(tokenPath: string): string {
	return (
		`no GitHub token configured for pi sync.\n` +
		`- run pi-sync in a terminal (tty) to start the GitHub device flow; it needs the OAuth client id config (run scripts/setup-sync-wizard.sh once), or\n` +
		`- create a personal access token with gist scope, then either write it to ${tokenPath} (owner-only: mkdir -p $(dirname ${tokenPath}) && printf '%s\\n' <token> > ${tokenPath} && chmod 600 ${tokenPath}), ` +
		`or set ${TOKEN_ENV} for this run.`
	);
}

/** Read the token file as async text for callers that need it. */
export async function readTokenText(stateDir: string): Promise<string | null> {
	try {
		return await readFile(tokenPathFor(stateDir), "utf8");
	} catch {
		return null;
	}
}
