import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import type { TextContent } from "@earendil-works/pi-ai";
import editAssistExtension, { diagnoseEditResult } from "../../extensions/edit-assist/index";
import { MAX_FILE_LINES } from "../../extensions/edit-assist/core";

const STOCK_ERROR =
	"Could not find the exact text in src/app.ts. The old text must match exactly including all whitespace and newlines.";

let cwd: string;
let agentDir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "edit-assist-wiring-"));
	agentDir = mkdtempSync(join(tmpdir(), "edit-assist-wiring-agent-"));
	env = { PI_CODING_AGENT_DIR: agentDir } as NodeJS.ProcessEnv;
});

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
	rmSync(agentDir, { recursive: true, force: true });
});

function projectSettings(obj: unknown): void {
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify(obj));
}

function editEvent(args: {
	path?: string;
	edits?: unknown;
	error?: string;
	isError?: boolean;
}): ToolResultEvent {
	return {
		type: "tool_result",
		toolName: "edit",
		toolCallId: "call-1",
		input: { path: args.path ?? "src/app.ts", edits: args.edits ?? [] },
		content: [{ type: "text", text: args.error ?? STOCK_ERROR }],
		details: undefined,
		isError: args.isError ?? true,
	} as ToolResultEvent;
}

const ctx = (dir: string): ExtensionContext => ({ cwd: dir }) as unknown as ExtensionContext;

describe("diagnoseEditResult", () => {
	it("appends the Diagnosis after the stock error, which stays verbatim", async () => {
		mkdirSync(join(cwd, "src"), { recursive: true });
		writeFileSync(join(cwd, "src", "app.ts"), "function run(): void {\n\tstart();\n\tstop();\n}\n");
		const event = editEvent({
			path: "src/app.ts",
			edits: [{ oldText: "function run(): void {\n  start();\n  stop();\n}", newText: "x" }],
		});
		const patch = await diagnoseEditResult(event, cwd, env);
		expect(patch).toBeDefined();
		const content = patch!.content as TextContent[];
		expect(content[0]).toEqual({ type: "text", text: STOCK_ERROR });
		expect(content[1]?.text).toContain("Diagnosis for edits[0] in src/app.ts:");
		expect(content[1]?.text).toContain("Nearest region: lines 1-4");
		expect(content[1]?.text).toContain(
			"The difference is a whitespace-only difference: same line count, leading whitespace only.",
		);
		expect(content[1]?.text).toMatch(/\n-/m);
		expect(content[1]?.text).toMatch(/\n\+/m);
	});

	it("returns undefined when the extension is disabled (off switch)", async () => {
		mkdirSync(join(cwd, "src"), { recursive: true });
		writeFileSync(join(cwd, "src", "app.ts"), "function run(): void {\n\tstart();\n}\n");
		projectSettings({ "edit-assist": { enabled: false } });
		const event = editEvent({ edits: [{ oldText: "function run(): void {\n  start();\n}", newText: "x" }] });
		const patch = await diagnoseEditResult(event, cwd, env);
		expect(patch).toBeUndefined();
	});

	it("returns undefined for a file over the line limit (stock error unchanged)", async () => {
		mkdirSync(join(cwd, "src"), { recursive: true });
		const many = Array.from({ length: MAX_FILE_LINES + 1 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
		writeFileSync(join(cwd, "src", "big.ts"), many);
		const event = editEvent({ edits: [{ oldText: "line 99", newText: "x" }] });
		const patch = await diagnoseEditResult(event, cwd, env);
		expect(patch).toBeUndefined();
	});

	it("returns undefined for a file over the byte limit (stock error unchanged)", async () => {
		mkdirSync(join(cwd, "src"), { recursive: true });
		writeFileSync(join(cwd, "src", "big.ts"), "x".repeat(300 * 1024 + 1) + "\n");
		const event = editEvent({ edits: [{ oldText: "x", newText: "y" }] });
		const patch = await diagnoseEditResult(event, cwd, env);
		expect(patch).toBeUndefined();
	});

	it("returns undefined for non-no-match edit errors", async () => {
		mkdirSync(join(cwd, "src"), { recursive: true });
		writeFileSync(join(cwd, "src", "app.ts"), "const a = 1;\nconst a = 1;\n");
		const event = editEvent({
			error:
				"Found 2 occurrences of the text in src/app.ts. The text must be unique. Please provide more context to make it unique.",
			edits: [{ oldText: "const a = 1;", newText: "x" }],
		});
		const patch = await diagnoseEditResult(event, cwd, env);
		expect(patch).toBeUndefined();
	});

	it("returns undefined for a successful edit", async () => {
		mkdirSync(join(cwd, "src"), { recursive: true });
		writeFileSync(join(cwd, "src", "app.ts"), "const a = 1;\n");
		const event = editEvent({
			error: "Successfully replaced 1 block(s) in src/app.ts.",
			isError: false,
			edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }],
		});
		const patch = await diagnoseEditResult(event, cwd, env);
		expect(patch).toBeUndefined();
	});

	it("returns undefined when the oldText matched after all (file changed since the error)", async () => {
		mkdirSync(join(cwd, "src"), { recursive: true });
		writeFileSync(join(cwd, "src", "app.ts"), "const a = 1;\n");
		const event = editEvent({ edits: [{ oldText: "const a = 1;", newText: "x" }] });
		const patch = await diagnoseEditResult(event, cwd, env);
		expect(patch).toBeUndefined();
	});

	it("returns undefined when the file cannot be read", async () => {
		const event = editEvent({ path: "src/missing.ts", edits: [{ oldText: "a", newText: "b" }] });
		const patch = await diagnoseEditResult(event, cwd, env);
		expect(patch).toBeUndefined();
	});

	it("resolves a relative path against the session cwd", async () => {
		mkdirSync(join(cwd, "src"), { recursive: true });
		writeFileSync(join(cwd, "src", "app.ts"), "const a = 1;\n");
		const event = editEvent({ path: "src/app.ts", edits: [{ oldText: "const a = 999;", newText: "x" }] });
		const patch = await diagnoseEditResult(event, cwd, env);
		expect(patch).toBeDefined();
	});

	it("ignores tools other than edit", async () => {
		const bashEvent = {
			type: "tool_result",
			toolName: "bash",
			toolCallId: "call-1",
			input: { command: "ls" },
			content: [{ type: "text", text: "Could not find anything" }],
			details: undefined,
			isError: true,
		} as ToolResultEvent;
		// The wiring's guard lives in the registered handler; exercise it via the
		// extension's handler capture.
		const captured: { handler?: (event: ToolResultEvent, ctx: ExtensionContext) => unknown } = {};
		editAssistExtension({
			on: (event: string, handler: unknown) => {
				if (event === "tool_result") captured.handler = handler as typeof captured.handler;
			},
		} as never);
		expect(captured.handler).toBeDefined();
		const result = await captured.handler!(bashEvent, ctx(cwd));
		expect(result).toBeUndefined();
	});
});
