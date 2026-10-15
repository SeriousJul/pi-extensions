/**
 * The server registry.
 *
 * The built-in table names the five languages the extension ships with and
 * the binaries it looks for on PATH. Settings can override a command or
 * disable a language (ADR 0040). The registry only finds what is already on
 * the machine: it never installs, downloads, or builds a server. A language
 * whose binary is absent is reported absent, in /lsp and in a tool error,
 * and costs nothing.
 */
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
	/** The file extensions that open a document of this language, dot-first. */
	extensions: string[];
	/** The root markers findRoot walks up for, in the registry's order. */
	rootMarkers: string[];
	/** The server's default arguments. */
	defaultArgs: string[];
}

/**
 * The built-in table (issue #136). Python prefers basedpyright and falls
 * back to pyright; every other language names one binary.
 */
export const BUILTIN_REGISTRY: ServerSpec[] = [
	{
		lang: "typescript",
		label: "TypeScript",
		binaries: ["typescript-language-server"],
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

/** Clear the binary cache (tests change PATH between cases). */
export function resetBinaryCache(): void {
	pathCache = null;
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
 * Resolve the built-in table through the settings overrides. A disabled
 * language is reported disabled; a language whose command (override or
 * built-in preference list) is not on PATH is reported absent, naming the
 * binary it looked for.
 */
export function resolveRegistry(settings: LspSettings, env: NodeJS.ProcessEnv = process.env): ResolvedServer[] {
	const out: ResolvedServer[] = [];
	for (const spec of BUILTIN_REGISTRY) {
		const override = settings.servers[spec.lang];
		if (override?.disabled === true) {
			out.push({ status: "disabled", lang: spec.lang, label: spec.label, reason: "disabled by settings" });
			continue;
		}
		let command = "";
		let lookedFor = "";
		if (override?.command) {
			lookedFor = override.command;
			command = findBinary(override.command, env) ?? (isExecutableFile(override.command) ? override.command : "");
			// A command that is an absolute or relative path does not need
			// PATH: it is what the operator named.
			if (!command && fs.existsSync(override.command)) command = override.command;
		} else {
			for (const name of spec.binaries) {
				const found = findBinary(name, env);
				if (found) {
					command = found;
					lookedFor = name;
					break;
				}
			}
			if (!command) lookedFor = spec.binaries.join(" or ");
		}
		if (!command) {
			out.push({ status: "absent", lang: spec.lang, label: spec.label, reason: `${lookedFor} not found on PATH` });
			continue;
		}
		out.push({
			status: "ready",
			lang: spec.lang,
			label: spec.label,
			command,
			args: override?.args ?? spec.defaultArgs,
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
