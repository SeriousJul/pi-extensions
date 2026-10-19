import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The repo root is one level above this file (ADR 0039: derive paths from
// the module's own location, never hardcode them).
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionsRoot = join(repoRoot, "extensions");
const docsExtensionsRoot = join(repoRoot, "docs", "extensions");

/**
 * The extensions the package ships, per the layout convention of the
 * develop page: every `.ts` file at the extensions root is a single-file
 * extension (name is the file basename, so `tools.ts` yields `tools`);
 * every subdirectory with an `index.ts` is a multi-file extension (name is
 * the directory name); a subdirectory without an `index.ts` is a shared
 * helper, not an extension.
 */
function discoverExtensions(): string[] {
	const names: string[] = [];
	for (const entry of readdirSync(extensionsRoot, { withFileTypes: true })) {
		if (entry.isFile() && entry.name.endsWith(".ts")) {
			names.push(entry.name.slice(0, -".ts".length));
		} else if (
			entry.isDirectory() &&
			existsSync(join(extensionsRoot, entry.name, "index.ts"))
		) {
			names.push(entry.name);
		}
	}
	return names.sort();
}

function firstCell(line: string): string {
	return line.trim().replace(/^\|+/, "").split("|")[0].trim();
}

function isSeparatorLine(line: string): boolean {
	return /^\|(\s*:?-+:?\s*\|)+\s*$/.test(line.trim());
}

/**
 * The first cell of each data row of the extensions table in the README.
 * The table is the block of `|` lines under the `## Extensions` heading:
 * its first row is the header, the separator row is recognized by its
 * dashes, and the remaining rows are the extension rows. Parsing the first
 * cell keeps the check immune to drift in the Docs cell.
 */
function readmeExtensionRows(): string[] {
	const lines = readFileSync(join(repoRoot, "README.md"), "utf8").split(/\r?\n/);
	const start = lines.findIndex((line) => line.startsWith("## Extensions"));
	if (start === -1) return [];
	const table: string[] = [];
	let inTable = false;
	for (let i = start + 1; i < lines.length; i++) {
		const line = lines[i];
		if (line.startsWith("## ")) break;
		if (line.trim().startsWith("|")) {
			inTable = true;
			if (isSeparatorLine(line)) continue;
			table.push(firstCell(line));
		} else if (inTable) {
			break; // the table ended
		}
	}
	return table.slice(1); // drop the header row
}

/**
 * Documentation exists for the extension in one of three forms: a single
 * docs page, a multi-page docs section, or a README inside the extension
 * directory.
 */
function hasDocumentation(name: string): boolean {
	if (existsSync(join(docsExtensionsRoot, `${name}.md`))) return true;
	const section = join(docsExtensionsRoot, name);
	if (existsSync(section) && statSync(section).isDirectory()) return true;
	return existsSync(join(extensionsRoot, name, "README.md"));
}

describe("extensions directory, README, and docs consistency", () => {
	it("has a README table row for every extension on disk", () => {
		const rows = readmeExtensionRows();
		const missing = discoverExtensions().filter((name) => !rows.includes(name));
		expect(missing, `README table row missing for: ${missing.join(", ")}`).toEqual([]);
	});

	it("has no stale README table row without a matching extension on disk", () => {
		const discovered = discoverExtensions();
		const stale = readmeExtensionRows().filter((name) => !discovered.includes(name));
		expect(stale, `stale README table row for: ${stale.join(", ")}`).toEqual([]);
	});

	it("has documentation for every extension on disk", () => {
		const undocumented = discoverExtensions().filter((name) => !hasDocumentation(name));
		expect(
			undocumented,
			`no documentation for: ${undocumented.join(", ")} (add docs/extensions/<name>.md, a docs/extensions/<name>/ section, or a README.md in the extension directory)`,
		).toEqual([]);
	});
});
