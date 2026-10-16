/**
 * The server registry.
 *
 * The built-in table names the five languages the extension ships with and
 * the binaries it looks for on PATH. Settings can override a command or
 * disable a language (ADR 0040). The registry only finds what is already on
 * the machine: it never installs, downloads, or builds a server. A language
 * whose binary is absent is reported absent, in /lsp and in a tool error,
 * and costs nothing.
 *
 * TypeScript is the one language with two server kinds (ADR 0044).
 * TypeScript 5 and 6 serve through typescript-language-server, which drives
 * the Node-based tsserver. TypeScript 7 is the native Go compiler, it
 * dropped tsserver, and it carries its own LSP server: `tsc --lsp
 * --stdio`. typescript-language-server therefore cannot serve a TS7
 * project, so the project's own typescript@7 (its node_modules tsc) always
 * wins for the root it serves, ahead of any machine-level binary. A tsc on
 * PATH only counts when it reports TypeScript 7 or newer: the 5.x/6.x tsc
 * is a compiler CLI that rejects --lsp.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { LspSettings } from "./types.ts";

/** One language of the built-in table. */
export interface ServerSpec {
	/** The settings key and the session's language id. */
	lang: string;
	/** The display name /lsp and results use. */
	label: string;
	/** Candidate binary names, in preference order. */
	binaries: string[];
	/**
	 * Native-compiler LSP candidate names, in preference order. Only
	 * TypeScript has them: tsc (TypeScript 7+) and tsgo (the native
	 * preview). A tsc only counts when it reports version 7 or newer.
	 */
	nativeBinaries?: string[];
	/** The default arguments of the native-compiler LSP. */
	nativeArgs?: string[];
	/** The file extensions that open a document of this language, dot-first. */
	extensions: string[];
	/** The root markers findRoot walks up for, in the registry's order. */
	rootMarkers: string[];
	/** The server's default arguments. */
	defaultArgs: string[];
}

/**
 * The built-in table (issue #136). Python prefers basedpyright and falls
 * back to pyright; every other language names one binary. TypeScript names
 * two kinds of server: typescript-language-server for TypeScript 5 and 6,
 * and the native TypeScript 7 compiler's built-in LSP, which needs the
 * the
 * --lsp --stdio pair.
 */
export const BUILTIN_REGISTRY: ServerSpec[] = [
	{
		lang: "typescript",
		label: "TypeScript",
		binaries: ["typescript-language-server"],
		nativeBinaries: ["tsc", "tsgo"],
		// The native LSP mode needs both flags; with only one it refuses to run.
		nativeArgs: ["--lsp", "--stdio"],
		extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
		rootMarkers: ["tsconfig.json", "package.json"],
		// The CLI needs --stdio: without it it refuses to run at all.
		defaultArgs: ["--stdio"],
	},
	{
		lang: "c-cpp",
		label: "C/C++",
		binaries: ["clangd"],
		extensions: [".c", ".cc", ".cpp", ".cxx", ".c++", ".h", ".hh", ".hpp", ".hxx", ".inl"],
		rootMarkers: ["compile_commands.json", "compile_flags.txt"],
		defaultArgs: [],
	},
	{
		lang: "rust",
		label: "Rust",
		binaries: ["rust-analyzer"],
		extensions: [".rs"],
		rootMarkers: ["Cargo.toml"],
		defaultArgs: [],
	},
	{
		lang: "python",
		label: "Python",
		binaries: ["basedpyright", "pyright"],
		extensions: [".py", ".pyi"],
		rootMarkers: ["pyproject.toml"],
		defaultArgs: [],
	},
	{
		lang: "go",
		label: "Go",
		binaries: ["gopls"],
		extensions: [".go"],
		rootMarkers: ["go.mod"],
		defaultArgs: [],
	},
];

/** The built-in specs keyed by language. */
export const BUILTIN_BY_LANG: Record<string, ServerSpec> = Object.fromEntries(BUILTIN_REGISTRY.map((s) => [s.lang, s]));

/**
 * The language of one file path, by its extension, or null for a file the
 * registry does not serve. A file with several matching extensions is
 * impossible by construction: the extension list is disjoint per language.
 */
export function languageForPath(file: string): string | null {
	const base = path.basename(file);
	const dot = base.lastIndexOf(".");
	if (dot <= 0) return null;
	const ext = base.slice(dot).toLowerCase();
	for (const spec of BUILTIN_REGISTRY) {
		if (spec.extensions.includes(ext)) return spec.lang;
	}
	return null;
}

let pathCache: { key: string; entries: Map<string, string> } | null = null;
let versionCache: { key: string; entries: Map<string, number> } | null = null;

/**
 * Resolve a binary name against PATH (and PATHEXT on Windows-shaped env).
 * The first name that exists and is executable wins. The result caches per
 * PATH value: the machine's binaries do not move while pi runs.
 */
export function findBinary(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
	const pathValue = env.PATH ?? env.Path ?? "";
	if (pathValue.length === 0) return undefined;
	if (pathCache === null || pathCache.key !== pathValue) {
		pathCache = { key: pathValue, entries: new Map() };
	}
	const cached = pathCache.entries.get(name);
	if (cached !== undefined) return cached.length > 0 ? cached : undefined;
	const exts = splitExtList(env.PATHEXT);
	const dirs = pathValue.split(path.delimiter).filter((d) => d.length > 0);
	let found = "";
	for (const dir of dirs) {
		for (const ext of exts) {
			const candidate = path.join(dir, name + ext);
			if (isExecutableFile(candidate)) {
				found = candidate;
				break;
			}
		}
		if (found) break;
	}
	pathCache.entries.set(name, found);
	return found.length > 0 ? found : undefined;
}

/** Clear the binary and version caches (tests change PATH between cases). */
export function resetBinaryCache(): void {
	pathCache = null;
	versionCache = null;
}

/** PATHEXT as candidate suffixes; empty when unset (Unix). */
function splitExtList(patext: string | undefined): string[] {
	if (!patext) return [""];
	const exts = patext.split(";").map((e) => e.toLowerCase());
	if (!exts.includes("")) exts.unshift("");
	return exts;
}

function isExecutableFile(file: string): boolean {
	try {
		const st = fs.statSync(file);
		if (!st.isFile()) return false;
	} catch {
		return false;
	}
	try {
		fs.accessSync(file, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** The state of one language after resolution. */
export type ResolvedServer =
	| { status: "ready"; lang: string; label: string; command: string; args: string[]; extensions: string[]; rootMarkers: string[] }
	| { status: "disabled"; lang: string; label: string; reason: string }
	| { status: "absent"; lang: string; label: string; reason: string };

/**
 * The project's own native TypeScript 7, walking up from startDir. The
 * nearest node_modules/typescript decides the whole tree: major 7 or newer
 * is the native compiler that carries the LSP, and a lower major stops the
 * walk, because for that tree the classic server remains the right answer
 * even if an outer directory holds a newer one. null when the tree has no
 * usable native tsc.
 */
export function findLocalNativeTypeScript(
	startDir: string,
	env: NodeJS.ProcessEnv = process.env,
): { command: string; dir: string } | null {
	let dir = path.resolve(startDir);
	for (;;) {
		const major = readTypeScriptMajor(path.join(dir, "node_modules", "typescript", "package.json"));
		if (major !== null) {
			if (major < 7) return null;
			const command = localTscCommand(dir, env);
			if (!command) return null; // typescript@7 without its tsc bin: a broken install
			return { command, dir };
		}
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/**
 * The command that serves TypeScript at this root when the project's own
 * typescript@7 provides it: the local native tsc and its --lsp --stdio
 * form. null when the root's nearest typescript is not native, or absent.
 */
export function nativeTypeScriptForRoot(
	root: string,
	env: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[] } | null {
	const spec = BUILTIN_BY_LANG.typescript;
	const local = findLocalNativeTypeScript(root, env);
	if (!local || !spec.nativeArgs) return null;
	return { command: local.command, args: spec.nativeArgs };
}

/** The major version the typescript package at pkgPath declares, or null. */
function readTypeScriptMajor(pkgPath: string): number | null {
	try {
		const raw = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version?: unknown };
		const major = Number.parseInt(String(raw?.version ?? ""), 10);
		return Number.isFinite(major) ? major : null;
	} catch {
		return null;
	}
}

/** The tsc bin the package at dir/node_modules installed, or undefined. */
function localTscCommand(dir: string, env: NodeJS.ProcessEnv): string | undefined {
	const base = path.join(dir, "node_modules", ".bin", "tsc");
	for (const ext of splitExtList(env.PATHEXT)) {
		const candidate = base + ext;
		if (isExecutableFile(candidate) || fs.existsSync(candidate)) return candidate;
	}
	return undefined;
}

/**
 * The major version of the TypeScript compiler a command provides, or 0
 * when it is not a native one. tsgo is the native preview and counts as 7
 * without a probe; a tsc is probed with --version and the answer caches per
 * command: a binary does not change its version while pi runs.
 */
function nativeTypeScriptMajor(command: string, env: NodeJS.ProcessEnv): number {
	const base = path.basename(command);
	if (base === "tsgo" || base === "tsgo.exe") return 7;
	if (!base.startsWith("tsc")) return 0;
	const key = `${env.PATH ?? ""}\0${command}`;
	if (versionCache === null) versionCache = { key: env.PATH ?? "", entries: new Map() };
	const cached = versionCache.entries.get(key);
	if (cached !== undefined) return cached;
	let major = 0;
	try {
		const out = execFileSync(command, ["--version"], {
			timeout: 3000,
			maxBuffer: 64 * 1024,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
			env,
		}) as string;
		const match = /version\s+(\d+)/i.exec(out) ?? /^(\d+)/.exec(out.trim());
		const n = match ? Number.parseInt(match[1], 10) : NaN;
		major = Number.isFinite(n) ? n : 0;
	} catch {
		// Not executable, or it hung: not a usable native compiler.
		major = 0;
	}
	versionCache.entries.set(key, major);
	return major;
}

/**
 * The command an operator named in settings: a name on PATH, a path
 * relative to the session root, or an absolute path. The result is
 * absolute, so the server process can run from any root.
 */
function resolveOverrideCommand(
	command: string,
	env: NodeJS.ProcessEnv,
	cwd: string | undefined,
): string {
	const fromPath = findBinary(command, env);
	if (fromPath) return fromPath;
	let candidate: string;
	if (path.isAbsolute(command)) candidate = command;
	else if (cwd) candidate = path.resolve(cwd, command);
	else return "";
	if (isExecutableFile(candidate) || fs.existsSync(candidate)) return candidate;
	return "";
}

/**
 * The default arguments for a command an operator named without args: the
 * native form when it names a native compiler bin, so a bare `tsc` command
 * is not started with the classic --stdio it would reject.
 */
function defaultArgsFor(command: string, spec: ServerSpec): string[] {
	const base = path.basename(command);
	if ((spec.nativeBinaries ?? []).includes(base) && spec.nativeArgs) return spec.nativeArgs;
	return spec.defaultArgs;
}

/**
 * The PATH candidates of one language in preference order: the classic
 * server binaries, then the native compiler LSP binaries, where a tsc only
 * counts when it reports TypeScript 7 or newer. Returns the found command
 * with its args, or the empty command with the names looked for.
 */
function resolveOnPath(
	spec: ServerSpec,
	env: NodeJS.ProcessEnv,
): { command: string; lookedFor: string; args: string[]; staleTsc?: string } {
	for (const name of spec.binaries) {
		const found = findBinary(name, env);
		if (found) return { command: found, lookedFor: name, args: spec.defaultArgs };
	}
	let staleTsc = "";
	for (const name of spec.nativeBinaries ?? []) {
		const found = findBinary(name, env);
		if (!found) continue;
		if (nativeTypeScriptMajor(found, env) < 7) {
			staleTsc = found; // a 5.x/6.x tsc on PATH is a compiler CLI, not a server
			continue;
		}
		return { command: found, lookedFor: name, args: spec.nativeArgs ?? [] };
	}
	const names = [...spec.binaries, ...(spec.nativeBinaries ?? [])];
	return { command: "", lookedFor: names.join(" or "), args: spec.defaultArgs, staleTsc };
}

/**
 * Resolve the built-in table through the settings overrides. A disabled
 * language is reported disabled. For TypeScript, the project's own
 * typescript@7 (walked up from the session root, when given) beats any
 * machine-level binary: it is the project's real compiler, and
 * typescript-language-server cannot serve it. A language whose command
 * (override or built-in preference list) is not found is reported absent,
 * naming the binary it looked for.
 */
export function resolveRegistry(
	settings: LspSettings,
	env: NodeJS.ProcessEnv = process.env,
	cwd?: string,
): ResolvedServer[] {
	const out: ResolvedServer[] = [];
	for (const spec of BUILTIN_REGISTRY) {
		const override = settings.servers[spec.lang];
		if (override?.disabled === true) {
			out.push({ status: "disabled", lang: spec.lang, label: spec.label, reason: "disabled by settings" });
			continue;
		}
		let command = "";
		let args: string[] = spec.defaultArgs;
		let lookedFor = "";
		let staleTsc = "";
		if (override?.command) {
			lookedFor = override.command;
			command = resolveOverrideCommand(override.command, env, cwd);
			args = override.args ?? defaultArgsFor(override.command, spec);
		} else if (spec.lang === "typescript" && cwd) {
			// The project's own native tsc serves the session root's tree.
			const local = findLocalNativeTypeScript(cwd, env);
			if (local && spec.nativeArgs) {
				command = local.command;
				args = spec.nativeArgs;
				lookedFor = `${local.dir}/node_modules/typescript (TypeScript 7 native LSP)`;
			} else {
				const onPath = resolveOnPath(spec, env);
				command = onPath.command;
				lookedFor = onPath.lookedFor;
				args = onPath.args;
				staleTsc = onPath.staleTsc ?? "";
			}
		} else {
			const onPath = resolveOnPath(spec, env);
			command = onPath.command;
			lookedFor = onPath.lookedFor;
			args = onPath.args;
			staleTsc = onPath.staleTsc ?? "";
		}
		if (!command) {
			let reason = `${lookedFor} not found`;
			if (override?.command) reason += `, looked on PATH and from ${cwd ?? "the working directory"}`;
			else reason += " on PATH";
			if (staleTsc) reason += `; ${staleTsc} is TypeScript below 7 and has no language server`;
			out.push({ status: "absent", lang: spec.lang, label: spec.label, reason });
			continue;
		}
		out.push({
			status: "ready",
			lang: spec.lang,
			label: spec.label,
			command,
			args,
			extensions: spec.extensions,
			rootMarkers: spec.rootMarkers,
		});
	}
	return out;
}

/** The ready entries of a resolved registry, keyed by language. */
export function readyByLang(resolved: ResolvedServer[]): Record<string, Extract<ResolvedServer, { status: "ready" }>> {
	const out: Record<string, Extract<ResolvedServer, { status: "ready" }>> = {};
	for (const entry of resolved) {
		if (entry.status === "ready") out[entry.lang] = entry;
	}
	return out;
}
