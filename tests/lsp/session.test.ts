/**
 * The LspSession state machine, driven through the LspClient seam (ADR
 * 0041): a scripted in-process fake server, so every behavior here is the
 * session's own - baselines, the post-edit annotation, the sweep, the
 * bounds, resync, and the one restart.
 *
 * The fixture convention is the fake's marker engine: a line holding
 * `ERR:<message>` yields an error diagnostic at the marker, and the same
 * for `WARN:` and `INFO:`. The fixture files below are written to a
 * throwaway project root whose settings point the registry at a fake
 * binary on a test PATH, so no real server is ever spawned.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { LspSession } from "../../extensions/lsp/session.ts";
import { FakeLspClient, type FakeClientScript } from "./fake-client.ts";

let root: string;
let bin: string;
let agentDir: string;
let env: NodeJS.ProcessEnv;
let clients: FakeLspClient[];
let makeClient: (opts: import("../../extensions/lsp/client.ts").LspClientOptions) => import("../../extensions/lsp/client.ts").LspClient;

/** Create the throwaway project: a PATH with fake server binaries, an
 *  agent dir for the per-call log, and the project settings. */
function makeProject(settings: Record<string, unknown> | null, files: Record<string, string> = {}): void {
	fs.mkdirSync(bin, { recursive: true });
	for (const name of ["fake-ts", "fake-c", "fake-py"]) {
		const p = path.join(bin, name);
		fs.writeFileSync(p, "#!/bin/sh\nexit 0\n");
		fs.chmodSync(p, 0o755);
	}
	fs.mkdirSync(path.join(root, ".pi"), { recursive: true });
	fs.mkdirSync(agentDir, { recursive: true });
	if (settings !== null) {
		fs.writeFileSync(path.join(root, ".pi", "settings.json"), JSON.stringify({ lsp: settings }, null, 2) + "\n");
	}
	for (const [name, text] of Object.entries(files)) {
		const p = path.join(root, name);
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.writeFileSync(p, text);
	}
	clients = [];
	makeClient = (opts) => {
		const client = new FakeLspClient(opts, scripts.shift() ?? {});
		clients.push(client);
		void client.ready.then(
			() => client.waitForReady(),
			() => client.crash({ code: 127 }),
		);
		return client as unknown as import("../../extensions/lsp/client.ts").LspClient;
	};
}

let scripts: FakeClientScript[] = [];
const script = (...s: FakeClientScript[]): void => {
	scripts = s;
};

/** The test's view of the latest context: trust on, no UI. */
function bind(ctx: { cwd?: string }): void {
	const session = lastSession!;
	session.setUi({
		cwd: ctx.cwd ?? root,
		isProjectTrusted: () => true,
		ui: { setStatus: () => undefined, notify: () => undefined, custom: async () => undefined },
	} as never);
}

/** The refusal text of a resolution, or a failure when it resolved. */
function refusalOf(res: import("../../extensions/lsp/session.ts").FileResolution | { refusal: string }): string {
	if ("refusal" in res) return res.refusal;
	throw new Error(`expected a refusal, resolved to ${res.lang} at ${res.root}`);
}

let lastSession: LspSession | undefined;

function session(opts: { noWatch?: boolean } = {}): LspSession {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		PATH: `${bin}:${process.env.PATH ?? ""}`,
		PI_CODING_AGENT_DIR: agentDir,
	};
	if (opts.noWatch !== false) env.LSP_NO_WATCH = "1";
	lastSession = new LspSession({ makeClient, env });
	bind({});
	return lastSession;
}

/** Write a file and move its mtime forward, like the agent's edit landed. */
function touch(file: string, text: string): void {
	const p = path.join(root, file);
	fs.writeFileSync(p, text);
	fs.utimesSync(p, new Date(Date.now() + 1000), new Date(Date.now() + 1000));
}

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-session-"));
	agentDir = path.join(root, ".agent");
	bin = path.join(root, "bin");
	scripts = [];
});

afterEach(() => {
	lastSession?.closeAll().catch(() => undefined);
	lastSession = undefined;
	fs.rmSync(root, { recursive: true, force: true });
});

const TS_SETTINGS = {
	servers: { typescript: { command: "fake-ts" } },
} as const;

describe("resolveForFile", () => {
	it("resolves a known file to its language server and root", () => {
		makeProject(TS_SETTINGS, { "app.ts": "let x = 1;" });
		const s = session();
		const res = s.resolveForFile(root, "app.ts", true, false);
		if ("refusal" in res) throw new Error(`refused: ${res.refusal}`);
		expect(res.lang).toBe("typescript");
		expect(res.root).toBe(root);
	});

	it("refuses an untrusted project unless the project settings enable lsp", () => {
		makeProject(TS_SETTINGS, { "app.ts": "let x = 1;" });
		const s = session();
		expect(refusalOf(s.resolveForFile(root, "app.ts", false, false))).toContain("not trusted");
		expect("refusal" in s.resolveForFile(root, "app.ts", false, true)).toBe(false);
	});

	it("refuses a language whose server is absent, naming the binary it looked for", () => {
		// The override names a binary that is on no PATH: the outcome does
		// not depend on what happens to be installed on this machine.
		makeProject(
			{
				servers: {
					typescript: { command: "fake-ts" },
					["c-cpp"]: { command: "definitely-not-installed" },
				},
			},
			{ "app.c": "int x;" },
		);
		const s = session();
		const refused = refusalOf(s.resolveForFile(root, "app.c", true, false));
		expect(refused).toContain("definitely-not-installed");
		expect(refused).toContain("not found on PATH");
	});

	it("refuses a language with no registry entry", () => {
		makeProject(TS_SETTINGS, { "app.xyz": "x" });
		const s = session();
		expect(refusalOf(s.resolveForFile(root, "app.xyz", true, false))).toContain("no language server");
	});
});

describe("the post-edit diagnostics loop", () => {
	it("reports only the diagnostics new against the pre-edit baseline", async () => {
		makeProject(TS_SETTINGS, { "app.ts": "let old = 1; // ERR:pre-existing problem\nlet fine = 2;\n" });
		script({});
		const s = session();

		// The agent starts the edit: the pre-edit state opens and settles.
		await s.onEditToolCall(root, "app.ts", true, false, true);
		const client = clients[0];
		const doc = [...(client.lastPublished.keys())][0];
		expect(client.lastPublished.get(doc)?.some((d) => d.message === "pre-existing problem")).toBe(true);

		// The edit lands on disk: the broken line replaces the clean one.
		touch("app.ts", "let old = 1; // ERR:pre-existing problem\nlet broken = 3; // ERR:the edit broke this\n");

		const note = await s.annotateEdit(root, "app.ts", "edit", true, false);
		expect(note).toBeDefined();
		expect(note).toContain("1 new diagnostic");
		expect(note).toContain("the edit broke this");
		expect(note).not.toContain("pre-existing problem");
	});

	it("says no new diagnostics when the edit introduced nothing", async () => {
		makeProject(TS_SETTINGS, { "app.ts": "let a = 1; // ERR:pre-existing problem\nlet b = 2;\n" });
		script({});
		const s = session();
		await s.onEditToolCall(root, "app.ts", true, false, true);
		// The edit lands with the same diagnostics: the re-sync re-publishes
		// the settled state and nothing is new against the baseline.
		touch("app.ts", "let a = 1; // ERR:pre-existing problem\nlet b = 2;\n");
		const note = await s.annotateEdit(root, "app.ts", "edit", true, false);
		expect(note).toBeDefined();
		expect(note).toContain("no new diagnostics");
	});

	it("a pre-state publish still in flight keeps the answer partial, and the sweep verifies the truth", async () => {
		makeProject(TS_SETTINGS, { "app.ts": "let a = 1; // ERR:old problem\n" });
		// Slower than the pre-settle cap: the pre-state publish lands after
		// the edit, so the annotation cannot trust the first publish it sees.
		script({ publishDelayMs: 4000 });
		const s = session();
		await s.onEditToolCall(root, "app.ts", true, false, true);
		touch("app.ts", "let a = 1; // ERR:old problem\nlet b = 2; // ERR:new problem\n");
		const note = await s.annotateEdit(root, "app.ts", "edit", true, false);
		expect(note).toBeDefined();
		expect(note).toContain("partial");
		expect(note).not.toContain("no new diagnostics");
		// The sweep forces a recompute and reports the true new diagnostic.
		const sweep = await s.sweep(root);
		expect(sweep).toBeDefined();
		expect(sweep!.text).toContain("new problem");
	});

	it("opens a just-written file from an empty baseline: everything is new", async () => {
		makeProject(TS_SETTINGS, {});
		script({});
		const s = session();
		await s.onEditToolCall(root, "fresh.ts", true, false, false);
		touch("fresh.ts", "let x = 1; // ERR:first error\nlet y = 2; // WARN:first warning\n");
		const note = await s.annotateEdit(root, "fresh.ts", "write", true, false);
		expect(note).toContain("2 new diagnostics");
		expect(note).toContain("first error");
		expect(note).toContain("first warning");
	});

	it("reports the other open documents of the same server, not just the edited file", async () => {
		makeProject(TS_SETTINGS, {
			"main.ts": "import { helper } from './util';\n",
			"util.ts": "export function helper() { return 1; }\n",
		});
		script({});
		const s = session();
		// Reading both files opens them and settles their (empty) baselines.
		await s.onReadToolCall(root, "util.ts", true, false);
		await s.onEditToolCall(root, "main.ts", true, false, true);
		const client = clients[0];
		// The edit to main.ts breaks util.ts as the server sees it.
		touch("main.ts", "import { helper } from './util';\nconst n: string = helper(); // ERR:the edit broke main\n");
		client.publishForTest([...client.lastPublished.keys()].find((k) => k.endsWith("util.ts"))!, [
			{
				range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
				severity: 1,
				message: "the edit broke util too",
			},
		]);
		const note = await s.annotateEdit(root, "main.ts", "edit", true, false);
		expect(note).toContain("the edit broke main");
		expect(note).toContain("util.ts");
		expect(note).toContain("the edit broke util too");
	});

	it("a timeout or dead server never passes the edit as clean", async () => {
		makeProject(TS_SETTINGS, { "app.ts": "let a = 1;\n" });
		script({ mode: "none" });
		const s = session();
		await s.onEditToolCall(root, "app.ts", true, false, true);
		await new Promise((r) => setTimeout(r, 30)); // the fake is ready and open happened
		touch("app.ts", "let a = 1; // ERR:something broke\n");
		const note = await s.annotateEdit(root, "app.ts", "edit", true, false);
		// Push mode never published: the answer is partial and says so.
		expect(note).toContain("partial");
		expect(note).not.toContain("no new diagnostics");
	});
});

describe("the sweep", () => {
	it("reports new error-severity diagnostics and never reports them twice", async () => {
		makeProject(TS_SETTINGS, { "app.ts": "let a = 1;\n" });
		script({});
		const s = session();
		await s.onEditToolCall(root, "app.ts", true, false, true);
		touch("app.ts", "let a = 1; // ERR:sweep finds this\n");
		const first = await s.sweep(root);
		expect(first).toBeDefined();
		expect(first!.text).toContain("1 new error diagnostic");
		expect(first!.text).toContain("sweep finds this");
		const second = await s.sweep(root);
		expect(second).toBeUndefined();
	});

	it("is silent when nothing new appeared", async () => {
		makeProject(TS_SETTINGS, { "app.ts": "let a = 1;\n" });
		script({});
		const s = session();
		await s.onEditToolCall(root, "app.ts", true, false, true);
		await s.sweep(root);
		expect(await s.sweep(root)).toBeUndefined();
	});
});

describe("document and server bounds", () => {
	it("evicts the idlest document past the open-document bound with a didClose", async () => {
		makeProject({ servers: { typescript: { command: "fake-ts" } }, maxOpenDocuments: 2 } as never, {
			"a.ts": "let a = 1;\n",
			"b.ts": "let b = 2;\n",
			"c.ts": "let c = 3;\n",
		});
		script({}, {}, {});
		const s = session();
		await s.onEditToolCall(root, "a.ts", true, false, true);
		await s.onEditToolCall(root, "b.ts", true, false, true);
		await s.onEditToolCall(root, "c.ts", true, false, true);
		const client = clients.find((c) => c.closedUris.length > 0);
		expect(client).toBeDefined();
		const closed = client!.closedUris;
		expect(closed).toHaveLength(1);
		expect(closed[0]).toContain("a.ts");
	});

	it("evicts the idlest server past the concurrent bound and keeps it dead for the session", async () => {
		makeProject(
			{
				servers: {
					typescript: { command: "fake-ts" },
					python: { command: "fake-py" },
					"c-cpp": { command: "fake-c" },
			},
			maxServers: 2,
			} as never,
			{ "a.ts": "let a = 1;\n", "b.py": "x = 1\n", "c.c": "int x;\n" },
		);
		script({}, {}, {});
		const s = session();
		await s.onEditToolCall(root, "a.ts", true, false, true);
		await s.onEditToolCall(root, "b.py", true, false, true);
		const before = clients.length;
		await s.onEditToolCall(root, "c.c", true, false, true);
		expect(clients.length).toBe(before + 1);
		// The idlest instance (typescript, touched first) was shut down
		// to make room for the third one.
		expect(clients.some((c) => c.state === "closed")).toBe(true);
		const closed = clients.find((c) => c.state === "closed");
		expect(closed?.label).toBe("TypeScript");
	});
});

describe("document sync from disk", () => {
	it("re-syncs a document whose file moved, without a re-open", async () => {
		makeProject(TS_SETTINGS, { "app.ts": "let a = 1;\n" });
		script({});
		const s = session();
		await s.onEditToolCall(root, "app.ts", true, false, true);
		const client = clients[0];
		const before = client.docs.size;
		// An external edit (script, sed, build): only the disk moved.
		touch("app.ts", "let a = 1; // ERR:external change\n");
		const note = await s.annotateEdit(root, "app.ts", "edit", true, false);
		expect(client.docs.size).toBe(before); // re-synced, not re-opened
		expect(note).toContain("external change");
	});
});

describe("crash handling", () => {
	it("restarts a crashed server once and serves the next call from the restart", async () => {
		makeProject(TS_SETTINGS, { "app.ts": "let a = 1;\n" });
		script({ crashAfterPublishes: 1 }, {});
		const s = session();
		await s.onEditToolCall(root, "app.ts", true, false, true);
		// The first publish crashed the server; the session restarted it.
		await new Promise((r) => setTimeout(r, 50));
		expect(clients).toHaveLength(2);
		const restarted = clients[1];
		expect(restarted.state).toBe("ready");
		// The restart re-opens the document from disk and answers.
		touch("app.ts", "let a = 1; // ERR:post-restart error\n");
		const note = await s.annotateEdit(root, "app.ts", "edit", true, false);
		expect(note).toContain("post-restart error");
	});

	it("a second crash stays dead: tools name the dead server, and no third start happens", async () => {
		makeProject(TS_SETTINGS, { "app.ts": "let a = 1;\n" });
		script({ crashAfterPublishes: 1 }, { crashAfterPublishes: 1 });
		const s = session();
		await s.onEditToolCall(root, "app.ts", true, false, true);
		await new Promise((r) => setTimeout(r, 50));
		expect(clients).toHaveLength(2);
		const started = clients.length;
		const result = await s.runTool("lsp_diagnostics", root, { file: "app.ts" }, true, false);
		expect(result.text).toContain("not running");
		expect(clients.length).toBe(started);
	});
});

describe("the tools", () => {
	it("lsp_diagnostics answers from the real server, capped and counted", async () => {
		const lines = ["let a = 1;"];
		for (let i = 0; i < 25; i += 1) lines.push(`let v${i} = ${i}; // ERR:problem ${i}`);
		makeProject(TS_SETTINGS, { "app.ts": lines.join("\n") + "\n" });
		script({});
		const s = session();
		const result = await s.runTool("lsp_diagnostics", root, { file: "app.ts" }, true, false);
		expect(result.text).toContain("25 diagnostics");
		expect(result.details?.counts).toEqual({ error: 25, warning: 0, info: 0, hint: 0 });
		// The result is capped: not every diagnostic line is printed.
		const linesShown = result.text.split("\n").filter((l) => l.startsWith("  E ")).length;
		expect(linesShown).toBeLessThan(25);
	});

	it("lsp_references answers from the server and is empty-labeled when it finds nothing", async () => {
		makeProject(TS_SETTINGS, { "app.ts": "const target = 1;\nconsole.log(target);\n" });
		script({});
		const s = session();
		const found = await s.runTool("lsp_references", root, { file: "app.ts", line: 1, character: 6 }, true, false);
		expect(found.text).toContain("reference");
		const none = await s.runTool("lsp_references", root, { file: "app.ts", line: 2, character: 15 }, true, false);
		expect(none.text).toContain("no references");
	});

	it("lsp_hover returns the server's hover text", async () => {
		makeProject(TS_SETTINGS, { "app.ts": "const x = 1;\n" });
		script({});
		const s = session();
		const result = await s.runTool("lsp_hover", root, { file: "app.ts", line: 1, character: 6 }, true, false);
		expect(result.text).toContain("fake hover");
	});

	it("refusals come back as text, not tool errors", async () => {
		makeProject(TS_SETTINGS, { "app.ts": "let a = 1;\n" });
		const s = session();
		const result = await s.runTool("lsp_diagnostics", root, { file: "app.xyz" }, true, false);
		expect(result.text).toContain("no language server");
		const untrusted = await s.runTool("lsp_diagnostics", root, { file: "app.ts" }, false, false);
		expect(untrusted.text).toContain("not trusted");
	});
});

describe("the /lsp status lines", () => {
	it("lists the registry state, the running server, and the watcher", () => {
		makeProject(TS_SETTINGS, { "app.ts": "let a = 1;\n" });
		script({});
		const s = session();
		const lines = s.statusLines(root, true, false);
		expect(lines.join("\n")).toContain("TypeScript:");
		expect(lines.join("\n")).toContain("watcher:");
		expect(lines.join("\n")).toContain("lsp:");
	});
});
