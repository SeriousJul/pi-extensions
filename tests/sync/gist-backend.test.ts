import { describe, expect, it } from "vitest";

import {
	createGistBackend,
	GIST_BASE_FILE,
	GIST_MANIFEST_FILE,
	gistLimitError,
	snapshotFromGist,
	toGistPayload,
	type GistTransport,
} from "../../extensions/sync/backends/github-gist.ts";
import { sha256Hex } from "../../extensions/sync/hash.ts";
import { DEFAULT_MANIFEST } from "../../extensions/sync/manifest.ts";
import type { Snapshot, SyncFile } from "../../extensions/sync/types.ts";

interface RecordedRequest {
	method: string;
	url: string;
	headers: Record<string, string>;
	body?: string;
}

/** A scriptable fake GitHub: canned responses in order, requests recorded. */
function makeTransport(responses: { status: number; json?: unknown; text?: string }[]): {
	transport: GistTransport;
	requests: RecordedRequest[];
} {
	const queue = [...responses];
	const requests: RecordedRequest[] = [];
	return {
		requests,
		transport: {
			request: async (method, url, options) => {
				requests.push({ method, url, headers: options.headers, body: options.body });
				const item = queue.shift();
				if (!item) return { status: 500, text: "no canned responses left" };
				return { status: item.status, text: item.json !== undefined ? JSON.stringify(item.json) : (item.text ?? "") };
			},
		},
	};
}

function gistJson(files: Record<string, { content?: string | null; raw_url?: string }>, id = "gid-1", updatedAt = "2026-01-01T00:00:00Z") {
	return { id, updated_at: updatedAt, files };
}

function snapshotOf(content: string, path = "AGENTS.md"): Snapshot {
	const f: SyncFile = { path, content, mtimeMs: 1_000, hash: sha256Hex(content) };
	return { manifest: DEFAULT_MANIFEST, base: { [path]: { hash: f.hash, mtimeMs: 1_000 } }, files: [f] };
}

describe("GistBackend against a stubbed GistTransport (no network)", () => {
	it("fetch maps a recorded gist response to a Snapshot with base-recorded mtimes", async () => {
		const fixture = gistJson({
			"AGENTS.md": { content: "# agents" },
			".pi/agent/settings.json": { content: "{}", raw_url: "https://gistcdn/settings.json" },
			[GIST_MANIFEST_FILE]: { content: JSON.stringify(DEFAULT_MANIFEST) },
			[GIST_BASE_FILE]: { content: JSON.stringify({ "AGENTS.md": { hash: sha256Hex("# agents"), mtimeMs: 123 } }) },
		});
		const canned = makeTransport([{ status: 200, json: fixture }]);
		const backend = createGistBackend({ gistId: "gid-1", token: "tok", baseUrl: "https://api.github.com", transport: canned.transport });
		const result = await backend.fetch();
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.manifest).toEqual(DEFAULT_MANIFEST);
		expect(result.value.files).toHaveLength(2);
		const agents = result.value.files.find((f) => f.path === "AGENTS.md")!;
		// The Base state carries the pusher's mtime, not the gist's.
		expect(agents.mtimeMs).toBe(123);
		expect(agents.hash).toBe(sha256Hex("# agents"));
		expect(result.value.updatedAtMs).toBe(Date.parse("2026-01-01T00:00:00Z"));

		expect(canned.requests).toHaveLength(1);
		expect(canned.requests[0].method).toBe("GET");
		expect(canned.requests[0].url).toBe("https://api.github.com/gists/gid-1");
		expect(canned.requests[0].headers.Authorization).toBe("Bearer tok");
	});

	it("fetch reads file content from the raw URL when the API omits it", async () => {
		const canned = makeTransport([
			{ status: 200, json: gistJson({ "AGENTS.md": { raw_url: "https://gistcdn/raw/agents" } }) },
			{ status: 200, text: "# agents via raw" },
		]);
		const backend = createGistBackend({ gistId: "gid-1", token: "tok", transport: canned.transport });
		const result = await backend.fetch();
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.files[0].content).toBe("# agents via raw");
		expect(canned.requests[1].url).toBe("https://gistcdn/raw/agents");
	});

	it("fetch returns not-found for a missing gist", async () => {
		const canned = makeTransport([{ status: 404, json: { message: "Not Found" } }]);
		const backend = createGistBackend({ gistId: "gone", token: "tok", transport: canned.transport });
		const result = await backend.fetch();
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("not-found");
		expect(result.message).toContain("gone");
	});

	it("fetch reports a token rejection without leaking the token", async () => {
		const canned = makeTransport([{ status: 401, text: "" }]);
		const backend = createGistBackend({ gistId: "gid-1", token: "secret-token", transport: canned.transport });
		const result = await backend.fetch();
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.message).toContain("rejected the token");
		expect(result.message).not.toContain("secret-token");
	});

	it("fetch without a gist id fails as not-found", async () => {
		const backend = createGistBackend({ token: "tok", transport: makeTransport([]).transport });
		const result = await backend.fetch();
		expect(result.ok).toBe(false);
	});

	it("create POSTs the snapshot as a secret gist with paths as file names", async () => {
		const canned = makeTransport([{ status: 201, json: gistJson({}, "new-id") }]);
		const backend = createGistBackend({ token: "tok", transport: canned.transport });
		const result = await backend.create(snapshotOf("# agents"));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value).toBe("new-id");

		const body = JSON.parse(canned.requests[0].body!);
		expect(canned.requests[0].method).toBe("POST");
		expect(canned.requests[0].url).toBe("https://api.github.com/gists");
		expect(body.public).toBe(false);
		expect(body.files["AGENTS.md"].content).toBe("# agents");
		expect(body.files[GIST_MANIFEST_FILE]).toBeDefined();
		expect(body.files[GIST_BASE_FILE]).toBeDefined();
	});

	it("push PATCHes the snapshot and deletes a file the Base state marks deleted", async () => {
		const canned = makeTransport([
			{
				status: 200,
				json: gistJson({
					"AGENTS.md": { content: "old" },
					"OPINIONS.md": { content: "dropped" },
					[GIST_MANIFEST_FILE]: { content: "{}" },
					[GIST_BASE_FILE]: { content: "{}" },
				}),
			},
			{ status: 200, json: gistJson({ "AGENTS.md": { content: "old" } }, "gid-1") },
		]);
		const backend = createGistBackend({ gistId: "gid-1", token: "tok", transport: canned.transport });
		const snapshot = snapshotOf("# agents v2");
		snapshot.base!["OPINIONS.md"] = { hash: sha256Hex("dropped"), mtimeMs: 1_000, deleted: true };
		const result = await backend.push(snapshot);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value).toEqual({ id: "gid-1", kept: [] });

		const [get, put] = canned.requests;
		expect(get.method).toBe("GET");
		expect(put.method).toBe("PATCH");
		const body = JSON.parse(put.body!);
		expect(body.files["AGENTS.md"].content).toBe("# agents v2");
		expect(body.files["OPINIONS.md"]).toBeNull();
		expect(body.files[GIST_MANIFEST_FILE]).toBeDefined();
	});

	it("push keeps a hand-added gist file (not in the snapshot, not deleted in the base) and reports it", async () => {
		const canned = makeTransport([
			{
				status: 200,
				json: gistJson({
					"AGENTS.md": { content: "old" },
					"notes/hand-added.md": { content: "hand" },
					[GIST_MANIFEST_FILE]: { content: "{}" },
					[GIST_BASE_FILE]: { content: "{}" },
				}),
			},
			{ status: 200, json: gistJson({ "AGENTS.md": { content: "old" } }, "gid-1") },
		]);
		const backend = createGistBackend({ gistId: "gid-1", token: "tok", transport: canned.transport });
		const result = await backend.push(snapshotOf("# agents v2"));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value).toEqual({ id: "gid-1", kept: ["notes/hand-added.md"] });

		const [, put] = canned.requests;
		const body = JSON.parse(put.body!);
		// The hand-added file is absent from the PATCH body: GitHub leaves it in place.
		expect(body.files["notes/hand-added.md"]).toBeUndefined();
	});

	it("rejects a snapshot that exceeds the gist file limit before any API call", async () => {
		const canned = makeTransport([]);
		const backend = createGistBackend({ gistId: "gid-1", token: "tok", transport: canned.transport });
		const files: SyncFile[] = [];
		for (let i = 0; i < 20; i++) {
			files.push({ path: `f${i}.md`, content: "x", mtimeMs: i, hash: sha256Hex("x") });
		}
		const result = await backend.push({ manifest: DEFAULT_MANIFEST, base: {}, files });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.message).toContain("at most 20 files");
		expect(canned.requests).toHaveLength(0);
	});
});

describe("mid-operation token renewal (issue #38)", () => {
	it("renews once after a 401 and retries the request once with the fresh token", async () => {
		let renewals = 0;
		const canned = makeTransport([
			{ status: 401, text: "" },
			{ status: 200, json: gistJson({ "AGENTS.md": { content: "# agents" } }) },
		]);
		const backend = createGistBackend({
			gistId: "gid-1",
			token: "stale",
			transport: canned.transport,
			onAuthFailure: async () => {
				renewals++;
				return "fresh";
			},
		});
		const result = await backend.fetch();
		expect(result.ok).toBe(true);
		expect(renewals).toBe(1);
		expect(canned.requests).toHaveLength(2);
		expect(canned.requests[0].headers.Authorization).toBe("Bearer stale");
		expect(canned.requests[1].headers.Authorization).toBe("Bearer fresh");
	});

	it("a 403 that survives the renewal is a clean error: one renewal, one retry, no loop", async () => {
		let renewals = 0;
		const canned = makeTransport([
			{ status: 403, text: "" },
			{ status: 403, text: "" },
		]);
		const backend = createGistBackend({
			gistId: "gid-1",
			token: "stale",
			transport: canned.transport,
			onAuthFailure: async () => {
				renewals++;
				return "fresh";
			},
		});
		const result = await backend.fetch();
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(renewals).toBe(1);
		expect(canned.requests).toHaveLength(2); // the original plus exactly one retry
		expect(result.message).toContain("after a renewal attempt");
	});

	it("a renewal that returns no token fails cleanly without a retry", async () => {
		let renewals = 0;
		const canned = makeTransport([{ status: 401, text: "" }]);
		const backend = createGistBackend({
			gistId: "gid-1",
			token: "stale",
			transport: canned.transport,
			onAuthFailure: async () => {
				renewals++;
				return undefined;
			},
		});
		const result = await backend.fetch();
		expect(result.ok).toBe(false);
		expect(renewals).toBe(1);
		expect(canned.requests).toHaveLength(1); // no retry without a fresh token
	});

	it("a 404 never renews: the plain not-found error stays", async () => {
		let renewals = 0;
		const canned = makeTransport([{ status: 404, json: { message: "Not Found" } }]);
		const backend = createGistBackend({
			gistId: "gone",
			token: "stale",
			transport: canned.transport,
			onAuthFailure: async () => {
				renewals++;
				return "fresh";
			},
		});
		const result = await backend.fetch();
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("not-found");
		expect(result.message).toContain("gone");
		expect(renewals).toBe(0); // a missing gist is not an auth problem
		expect(canned.requests).toHaveLength(1);
	});
});

describe("toGistPayload", () => {
	it("puts user files at their home-relative paths and the tool files at the gist root", () => {
		const snapshot = snapshotOf("# agents");
		const payload = toGistPayload(snapshot);
		expect(Object.keys(payload.files).sort()).toEqual([GIST_BASE_FILE, GIST_MANIFEST_FILE, "AGENTS.md"]);
		expect(payload.totalBytes).toBeGreaterThan(0);
	});
});

describe("gistLimitError", () => {
	it("flags snapshots over 10 MB", () => {
		const big = "x".repeat(10 * 1024 * 1024);
		const snapshot: Snapshot = { manifest: DEFAULT_MANIFEST, base: {}, files: [{ path: "big.md", content: big, mtimeMs: 0, hash: sha256Hex(big) }] };
		expect(gistLimitError(snapshot)).not.toBeNull();
	});

	it("passes a small snapshot", () => {
		expect(gistLimitError(snapshotOf("small"))).toBeNull();
	});
});

describe("snapshotFromGist", () => {
	it("returns a null manifest for a hand-created gist without the tool file", async () => {
		const snapshot = await snapshotFromGist(gistJson({ "AGENTS.md": { content: "hi" } }), async (f) => f.content ?? "");
		expect(snapshot.manifest).toBeNull();
		expect(snapshot.base).toBeNull();
		expect(snapshot.files).toHaveLength(1);
	});
});
