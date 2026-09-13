import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** pi's built-in default for compaction.reserveTokens (packages/coding-agent compaction settings). */
export const DEFAULT_RESERVE_TOKENS = 16384;

interface SettingsShape {
	compaction?: { reserveTokens?: unknown };
}

/**
 * Read the effective compaction.reserveTokens the way pi merges settings:
 * project <cwd>/.pi/settings.json overrides global <agentDir>/settings.json,
 * which defaults to ~/.pi/agent. Missing or unreadable files fall through to
 * the built-in default.
 */
export function readReserveTokens(cwd: string, env: NodeJS.ProcessEnv = process.env): number {
	const globalPath = env.PI_CODING_AGENT_DIR
		? join(env.PI_CODING_AGENT_DIR, "settings.json")
		: join(homedir(), ".pi", "agent", "settings.json");
	const projectPath = join(cwd, ".pi", "settings.json");
	return readReserveTokensAt(projectPath) ?? readReserveTokensAt(globalPath) ?? DEFAULT_RESERVE_TOKENS;
}

function readReserveTokensAt(path: string): number | undefined {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as SettingsShape;
		const value = parsed?.compaction?.reserveTokens;
		return typeof value === "number" && Number.isFinite(value) ? value : undefined;
	} catch {
		return undefined;
	}
}
