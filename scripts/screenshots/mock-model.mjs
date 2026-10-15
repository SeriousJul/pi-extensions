/**
 * Mock model server for the screenshot captures.
 *
 * A local OpenAI-compatible /v1/chat/completions endpoint. Three models:
 *   - mock-orig:    every request fails with a terminal 429 usage-limit body
 *                   (the exact shape the model-router classifier matches)
 *   - mock-fallback: answers with a fixed text reply
 *   - mock-tools:   answers the first turn with two tool calls (a real `read`
 *                   and a real `bash`), so pi runs real tools and draws real
 *                   Tool rows; the follow-up turn (the request now carries the
 *                   tool results) closes with a fixed reply
 * No request leaves the machine.
 */
import { createServer } from "node:http";

export const QUOTA_ERROR_BODY = {
	error: {
		message: "Your ChatGPT plan usage limit has been reached for this window.",
		type: "usage_limit_reached",
		code: "usage_limit_reached",
	},
};

export const FALLBACK_REPLY = "Hello! I am the fallback model.";

/**
 * The tool calls the tool-headers capture drives. `note.txt` must exist in
 * the capture's cwd; `sleep 0.2` puts the bash wall time in a stable 0.2s
 * bucket, so the settled screen is byte-identical on every machine.
 */
const TOOLS_TOOL_CALLS = [
	{ index: 0, id: "call-read", name: "read", arguments: { path: "note.txt" } },
	{ index: 1, id: "call-bash", name: "bash", arguments: { command: "sleep 0.2; echo greeting" } },
];
const TOOLS_FINAL_REPLY = "Done.";

/**
 * Start the mock model server on a local port.
 * @returns {Promise<{port: number, close: () => Promise<void>}>}
 */
export async function startMockModelServer() {
	const server = createServer((req, res) => {
		if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
			res.writeHead(404, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: `unknown route ${req.url}` } }));
			return;
		}
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", () => {
			let model = "";
			let messages = [];
			try {
				const parsed = JSON.parse(body);
				model = parsed.model ?? "";
				messages = Array.isArray(parsed.messages) ? parsed.messages : [];
			} catch {
				// Unreadable body: treat as the failing model.
			}
			if (model === "mock-orig") {
				res.writeHead(429, { "content-type": "application/json" });
				res.end(JSON.stringify(QUOTA_ERROR_BODY));
				return;
			}
			const chunk = (payload) => `data: ${JSON.stringify(payload)}\n\n`;
			const finish = (base, deltas) => {
				res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
				for (const delta of deltas) res.write(chunk({ ...base, choices: [{ index: 0, delta, finish_reason: null }] }));
				res.write(chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: base.finishReason }] }));
				res.write("data: [DONE]\n\n");
				res.end();
			};
			if (model === "mock-tools") {
				// A request with no tool result yet is the first turn: answer
				// with tool calls. One carrying tool results is the follow-up:
				// close the turn. Stateless, so both captures share the server.
				const base = { id: "cmpl-mock", object: "chat.completion.chunk", created: 0, model: "mock-tools", finishReason: "tool_calls" };
				const hasToolResult = messages.some((m) => m && m.role === "tool");
				if (!hasToolResult) {
					finish(base, TOOLS_TOOL_CALLS.map((call) => ({ tool_calls: [{ index: call.index, id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] })));
				} else {
					const done = { ...base, finishReason: "stop" };
					finish(done, [{ role: "assistant", content: TOOLS_FINAL_REPLY }]);
				}
				return;
			}
			// SSE chat completion for mock-fallback.
			const base = {
				id: "cmpl-mock",
				object: "chat.completion.chunk",
				created: 0,
				model: "mock-fallback",
				finishReason: "stop",
			};
			finish(base, [{ role: "assistant", content: FALLBACK_REPLY }]);
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = server.address().port;
	return {
		port,
		close: () => new Promise((resolve) => server.close(resolve)),
	};
}
