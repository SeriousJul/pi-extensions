/**
 * Mock model server for the model-router capture.
 *
 * A local OpenAI-compatible /v1/chat/completions endpoint. Requests for
 * "mock-orig" fail with a terminal 429 usage-limit body (the exact shape
 * the classifier matches); requests for "mock-fallback" answer with a
 * fixed SSE chat completion. No request leaves the machine.
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
 * Start the mock model server on a local port.
 * @returns {Promise<{port: number, close: () => Promise<void>}>}
 */
export async function startMockModelServer() {
	const server = createServer((req, res) => {
		if (req.method === "POST" && req.url === "/v1/chat/completions") {
			let body = "";
			req.on("data", (chunk) => {
				body += chunk;
			});
			req.on("end", () => {
				let model = "";
				try {
					model = JSON.parse(body).model ?? "";
				} catch {
					// Unreadable body: treat as the failing model.
				}
				if (model === "mock-orig") {
					res.writeHead(429, { "content-type": "application/json" });
					res.end(JSON.stringify(QUOTA_ERROR_BODY));
					return;
				}
				// SSE chat completion for mock-fallback.
				res.writeHead(200, {
					"content-type": "text/event-stream",
					"cache-control": "no-cache",
				});
				const chunk = (payload) => `data: ${JSON.stringify(payload)}\n\n`;
				const base = {
					id: "cmpl-mock",
					object: "chat.completion.chunk",
					created: 0,
					model: "mock-fallback",
				};
				res.write(chunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: FALLBACK_REPLY }, finish_reason: null }] }));
				res.write(chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
				res.write("data: [DONE]\n\n");
				res.end();
			});
			return;
		}
		res.writeHead(404, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: { message: `unknown route ${req.url}` } }));
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = server.address().port;
	return {
		port,
		close: () => new Promise((resolve) => server.close(resolve)),
	};
}
