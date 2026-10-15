/**
 * Mock provider extension for screenshot captures.
 *
 * Registers a "mock" provider with three OpenAI-compatible models against
 * the local mock model server (port from MOCK_MODEL_PORT):
 *   - mock-orig:     every request fails with a terminal 429 usage limit
 *   - mock-fallback: answers with a fixed reply
 *   - mock-tools:    first turn answers with tool calls (read, bash), so pi
 *                    runs real tools and draws real Tool rows
 * Used by the model-router, context-cap, and tool-headers captures; no
 * request leaves the machine.
 */
export default function (pi) {
	const port = process.env.MOCK_MODEL_PORT;
	if (!port) throw new Error("MOCK_MODEL_PORT is not set");
	pi.registerProvider("mock", {
		name: "Mock",
		baseUrl: `http://127.0.0.1:${port}/v1`,
		apiKey: "mock-key",
		api: "openai-completions",
		models: [
			{
				id: "mock-orig",
				name: "Mock Original",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 4096,
			},
			{
				id: "mock-fallback",
				name: "Mock Fallback",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 4096,
			},
			{
				id: "mock-tools",
				name: "Mock Tools",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 4096,
			},
		],
	});
}
