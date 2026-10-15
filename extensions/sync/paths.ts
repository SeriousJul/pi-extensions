/**
 * Where this install lives and how to run what it ships (ADR 0039).
 *
 * pi installs the package into a directory the user does not choose, so
 * every command line the tool prints is absolute and derived from this
 * file's own location at runtime: a module knows where it lives, while a
 * path printed relative to the source checkout resolves to nothing on a
 * user's machine. The presence of the Account setup script is checked when
 * a message is built, not at module load: an install can be missing it.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The Install root: the directory this package was installed into. */
export function packageRoot(): string {
	// This file is <install root>/extensions/sync/paths.ts.
	return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** The absolute path to the Account setup script. The install may lack it. */
export function accountSetupScriptPath(): string {
	return join(packageRoot(), "scripts", "setup-sync-wizard.sh");
}

/** The absolute path to the pi-sync CLI entry. */
export function cliEntryPath(): string {
	return join(packageRoot(), "extensions", "sync", "cli.mjs");
}

/**
 * Quote a value for shell paste. A path the shell leaves alone stays bare;
 * anything the shell acts on (space, tab, & ( ) ' and friends) is
 * single-quoted, with the usual ' escaping.
 */
export function shellQuote(value: string): string {
	if (value !== "" && /^[A-Za-z0-9_./@:%+=~-]*$/.test(value)) return value;
	return `'${value.replaceAll("'", "'\\''")}'`;
}

/** The runnable CLI line: node <abs cli.mjs> <verb>. */
export function cliCommand(verb: string): string {
	return `node ${shellQuote(cliEntryPath())} ${verb}`;
}

/** The Account setup as this install ships it, checked at message-build time. */
export interface AccountSetup {
	/** The script is present in this install. */
	present: boolean;
	/** The absolute path to the script, present or not. */
	path: string;
	/** The runnable line: bash <abs script>. An install can lose the exec bit; bash <path> never cares. */
	command: string;
}

export function accountSetup(): AccountSetup {
	const path = accountSetupScriptPath();
	return { present: existsSync(path), path, command: `bash ${shellQuote(path)}` };
}

/** The escape-hatch half when the script is missing: the env var leads. */
export function clientSetupMissing(setup: AccountSetup, clientIdEnv: string): string {
	return `Set ${clientIdEnv} for this run (the Account setup script ${setup.path} is not present in this install)`;
}

/**
 * How to make the OAuth client id known on this device, for a device that
 * has none. The runnable Account setup line when the script ships, else the
 * plain absence with the escape hatch env var leading.
 */
export function clientSetupInstruction(setup: AccountSetup, clientIdEnv: string): string {
	return setup.present
		? `Run ${setup.command} once (it walks the GitHub OAuth app steps and stores the client id), or set ${clientIdEnv}`
		: clientSetupMissing(setup, clientIdEnv);
}

/**
 * The shorter fix, for a config file that exists but is broken: re-run the
 * Account setup, or set the env var.
 */
export function clientReRunFix(setup: AccountSetup, clientIdEnv: string): string {
	return setup.present ? `re-run ${setup.command} or set ${clientIdEnv}` : clientSetupMissing(setup, clientIdEnv);
}
