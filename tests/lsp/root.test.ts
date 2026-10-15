/**
 * Root discovery: the nearest marker root wins, the walk respects the
 * language's marker list, and a file with no marker above it falls back to
 * the session root.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { findRoot, hasMarker, rootForFile } from "../../extensions/lsp/root.ts";

let root: string;

function touch(p: string): void {
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, "");
}

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-root-"));
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe("findRoot", () => {
	it("returns null when there are no markers to look for", () => {
		expect(findRoot(root, [])).toBeNull();
	});

	it("finds the nearest ancestor carrying a marker", () => {
		const crate = path.join(root, "workspace", "crates", "api");
		fs.mkdirSync(crate, { recursive: true });
		touch(path.join(root, "workspace", "Cargo.toml"));
		touch(path.join(crate, "Cargo.toml"));
		// The crate's own marker beats the workspace's.
		expect(findRoot(crate, ["Cargo.toml"])).toBe(crate);
		const sibling = path.join(crate, "src");
		fs.mkdirSync(sibling, { recursive: true });
		expect(findRoot(sibling, ["Cargo.toml"])).toBe(crate);
	});

	it("walks up through several levels to the first marker", () => {
		const deep = path.join(root, "a", "b", "c");
		fs.mkdirSync(deep, { recursive: true });
		touch(path.join(root, "package.json"));
		expect(findRoot(deep, ["package.json"])).toBe(root);
	});

	it("returns null when no ancestor has a marker", () => {
		const deep = path.join(root, "a", "b");
		fs.mkdirSync(deep, { recursive: true });
		expect(findRoot(deep, ["Cargo.toml"])).toBeNull();
	});

	it("a directory marker does not count: the marker must be a file", () => {
		fs.mkdirSync(path.join(root, "tsconfig.json"), { recursive: true });
		expect(hasMarker(root, ["tsconfig.json"])).toBe(false);
	});
});

describe("rootForFile", () => {
	it("resolves a relative file against the cwd and finds the marker root", () => {
		const proj = path.join(root, "proj");
		fs.mkdirSync(path.join(proj, "src"), { recursive: true });
		touch(path.join(proj, "tsconfig.json"));
		touch(path.join(proj, "src", "app.ts"));
		expect(rootForFile("src/app.ts", proj, "typescript", ["tsconfig.json"], proj)).toBe(proj);
	});

	it("falls back to the session root when no marker is above the file", () => {
		const proj = path.join(root, "proj");
		fs.mkdirSync(path.join(proj, "src"), { recursive: true });
		touch(path.join(proj, "src", "app.ts"));
		expect(rootForFile("src/app.ts", proj, "typescript", ["tsconfig.json"], proj)).toBe(proj);
	});

	it("an in-tree marker closer than the session root wins over it", () => {
		const proj = path.join(root, "proj");
		const nested = path.join(proj, "pkg");
		fs.mkdirSync(path.join(nested, "src"), { recursive: true });
		touch(path.join(proj, "tsconfig.json"));
		touch(path.join(nested, "tsconfig.json"));
		touch(path.join(nested, "src", "x.ts"));
		expect(rootForFile("pkg/src/x.ts", proj, "typescript", ["tsconfig.json"], proj)).toBe(nested);
	});
});
