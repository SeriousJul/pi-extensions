/**
 * The watcher policy: what may be watched, what is filtered out of event
 * paths, and the one recursive watch per root that degrades instead of
 * throwing. The event test waits out the debounce - it is the one behavior
 * the whole Changed set depends on.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
	WATCH_DEBOUNCE_MS,
	isExcludedPath,
	resetWslCache,
	startRootWatcher,
	type RootWatcherHooks,
	watchDisabledReason,
} from "../../extensions/lsp/watcher.ts";

let root: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-watcher-"));
	env = { ...process.env };
});

afterEach(() => {
	resetWslCache();
	fs.rmSync(root, { recursive: true, force: true });
});

describe("watchDisabledReason", () => {
	it("is null for an ordinary project root", () => {
		expect(watchDisabledReason(root, env)).toBeNull();
	});

	it("honors LSP_NO_WATCH=1", () => {
		expect(watchDisabledReason(root, { ...env, LSP_NO_WATCH: "1" })).toBe("LSP_NO_WATCH=1");
	});

	it("never watches the home directory", () => {
		const env = { ...process.env, HOME: root };
		expect(watchDisabledReason(root, env)).toBe("home directory");
	});

	it("never watches a WSL2 /mnt root", () => {
		resetWslCache();
		const env = { ...process.env, WSL_DISTRO_NAME: "Ubuntu" };
		expect(watchDisabledReason("/mnt/c/project", env)).toBe("WSL2 /mnt drive");
		expect(watchDisabledReason("/home/me/project", env)).toBeNull();
	});
});

describe("isExcludedPath", () => {
	it("filters a path through an excluded directory", () => {
		expect(isExcludedPath(root, path.join(root, "node_modules", "x", "y.js"))).toBe(true);
		expect(isExcludedPath(root, path.join(root, ".git", "HEAD"))).toBe(true);
		expect(isExcludedPath(root, path.join(root, "build", "dist", "out.js"))).toBe(true);
	});

	it("does not filter ordinary paths", () => {
		expect(isExcludedPath(root, path.join(root, "src", "app.ts"))).toBe(false);
		expect(isExcludedPath(root, path.join(root, "my-node_modules", "a.js"))).toBe(false);
	});

	it("a path outside the root is not filtered", () => {
		expect(isExcludedPath(root, "/elsewhere/node_modules/a.js")).toBe(false);
	});
});

describe("startRootWatcher", () => {
	it("reports disabled with the reason when the policy forbids it", () => {
		const w = startRootWatcher(root, noopHooks, { ...env, LSP_NO_WATCH: "1" });
		expect(w.state).toBe("disabled");
		w.stop();
	});

	it("runs active for an ordinary root and reports a debounced change batch", async () => {
		const seen: string[][] = [];
		const degraded: string[] = [];
		const w = startRootWatcher(
			root,
			{
				onEvents: (paths) => seen.push(paths),
				onDegraded: (reason) => degraded.push(reason),
			},
			env,
		);
		try {
			expect(w.state).toBe("active");
			// Two fast writes become one batch after the debounce.
			fs.writeFileSync(path.join(root, "a.ts"), "let a = 1;\n");
			fs.writeFileSync(path.join(root, "b.ts"), "let b = 2;\n");
			await new Promise((r) => setTimeout(r, WATCH_DEBOUNCE_MS + 400));
			expect(degraded).toEqual([]);
			expect(seen.length).toBeGreaterThanOrEqual(1);
			const flat = seen.flat().map((p) => path.basename(p));
			expect(flat).toContain("a.ts");
			expect(flat).toContain("b.ts");
			// Excluded paths never surface.
			fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
			fs.writeFileSync(path.join(root, "node_modules", "dep.js"), "x");
			await new Promise((r) => setTimeout(r, WATCH_DEBOUNCE_MS + 400));
			expect(seen.flat().some((p) => p.includes("node_modules"))).toBe(false);
		} finally {
			w.stop();
		}
	});

	it("a stop is idempotent and silences further events", async () => {
		const seen: string[][] = [];
		const w = startRootWatcher(root, { onEvents: (p) => seen.push(p), onDegraded: () => undefined }, env);
		w.stop();
		w.stop();
		fs.writeFileSync(path.join(root, "late.ts"), "let x = 1;\n");
		await new Promise((r) => setTimeout(r, WATCH_DEBOUNCE_MS + 400));
		expect(seen).toEqual([]);
	});
});

const noopHooks: RootWatcherHooks = { onEvents: () => undefined, onDegraded: () => undefined };
