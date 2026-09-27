// Shared mock llama.cpp router server for e2e tests.
//
// Speaks just enough of the llama.cpp router contract for pi's built-in
// llama.cpp provider to list models, derive context windows, and stream
// completions:
//
//   GET  /models                      -> { data: [modelInfo] }
//   GET  /props                       -> { models_autoload: false }
//   GET  /props?model=<id>            -> { chat_template: "..." }
//   POST /v1/chat/completions         -> OpenAI-compatible SSE
//
// Models are mutable so a test can drift the catalog between two reads: the
// reported `meta.n_ctx` is exposed only while the model is loaded, exactly
// like a real router (an asleep model exposes no `n_ctx`, so the provider
// derives the Fallback window for it). A completions request wakes any
// sleeping model it targets, the way the real router loads on demand.
//
// Every completions request is recorded, including its `max_tokens`, so a
// test can assert the window the session actually used.

import { createServer } from "node:http";

function modelInfo(id, m) {
	const info = {
		id,
		status: { value: m.status },
		source: m.source ?? "loaded",
		architecture: { input_modalities: ["text"] },
	};
	// Only a loaded model exposes its `n_ctx`; asleep models report none,
	// and the provider then derives the Fallback window.
	if (m.status === "loaded" && m.nCtx !== undefined && m.nCtx !== null) {
		info.meta = { n_ctx: m.nCtx };
	}
	return info;
}

export async function startLlamaMockRouter(options = {}) {
	const { models: initial = {}, port } = options;
	const state = new Map(Object.entries(initial).map(([id, m]) => [id, { nCtx: undefined, status: "loaded", ...m }]));
	// Every completions request, in order: { model, maxTokens, body }.
	const requests = [];
	// Catalog reads, in order: { path } for /models and /props.
	const catalogReads = [];
	// One scripted completions response, consumed by the next request.
	let scripted = undefined;
	// Drift applied right after the next completions request is handled.
	let driftOnRequest = undefined;

	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", () => {
			const url = new URL(req.url ?? "/", "http://localhost");
			if (req.method === "GET" && url.pathname === "/models") {
				catalogReads.push({ path: req.url ?? "/" });
				res.setHeader("content-type", "application/json");
				res.end(JSON.stringify({ data: [...state].map(([id, m]) => modelInfo(id, m)) }));
			} else if (req.method === "GET" && url.pathname === "/props") {
				catalogReads.push({ path: req.url ?? "/" });
				res.setHeader("content-type", "application/json");
				if (url.searchParams.get("model")) {
					res.end(JSON.stringify({ chat_template: "{{ .Content }}" }));
				} else {
					res.end(JSON.stringify({ models_autoload: false }));
				}
			} else if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
				let parsed;
				try {
					parsed = JSON.parse(body);
				} catch {
					parsed = {};
				}
				const response = scripted ?? { content: "Confirmed.", finishReason: "stop", outputTokens: 3 };
				scripted = undefined;
				requests.push({ model: parsed.model, maxTokens: parsed.max_tokens, body: parsed });
				// A request wakes a sleeping model, the way the real router
				// loads on demand.
				const target = state.get(parsed.model);
				if (target) {
					if (target.status === "sleeping") target.status = "loaded";
				} else {
					for (const m of state.values()) if (m.status === "sleeping") m.status = "loaded";
				}
				res.writeHead(200, { "content-type": "text/event-stream" });
				res.write(`data: ${JSON.stringify({ id: "cmpl-1", choices: [{ index: 0, delta: { content: response.content } }] })}\n\n`);
				res.write(
					`data: ${JSON.stringify({
						id: "cmpl-1",
						choices: [{ index: 0, delta: {}, finish_reason: response.finishReason }],
						usage: { prompt_tokens: 4, completion_tokens: response.outputTokens, total_tokens: 4 + response.outputTokens },
					})}\n\n`,
				);
				res.write("data: [DONE]\n\n");
				res.end();
				if (driftOnRequest) {
					const drifted = state.get(driftOnRequest.id);
					if (drifted) drifted.nCtx = driftOnRequest.nCtx;
					driftOnRequest = undefined;
				}
			} else {
				res.statusCode = 404;
				res.setHeader("content-type", "application/json");
				res.end(JSON.stringify({ error: `unexpected request: ${req.method} ${req.url}` }));
			}
		});
	});

	const handle = {
		async listen() {
			await new Promise((resolve) => server.listen(port ?? 0, "127.0.0.1", resolve));
			return handle;
		},
		get port() {
			return server.address().port;
		},
		get url() {
			return `http://127.0.0.1:${server.address().port}`;
		},
		/** The current model table: { [id]: { nCtx, status } }. */
		models() {
			return Object.fromEntries(state);
		},
		/** Set (or add) a model's reported n_ctx and status. */
		setModel(id, { nCtx, status }) {
			const current = state.get(id) ?? { nCtx: undefined, status: "loaded" };
			state.set(id, { ...current, ...(nCtx !== undefined && { nCtx }), ...(status !== undefined && { status }) });
		},
		/** Change only the reported n_ctx of a model. */
		setNCtx(id, nCtx) {
			handle.setModel(id, { nCtx });
		},
		/** Change only the status of a model. */
		setStatus(id, status) {
			handle.setModel(id, { status });
		},
		/** Script the next completions response: { content, finishReason, outputTokens }. */
		scriptResponse(response) {
			scripted = response;
		},
		/** Drift a model's reported n_ctx right after the next completions request. */
		driftAfterRequest(id, nCtx) {
			driftOnRequest = { id, nCtx };
		},
		requests,
		catalogReads,
		close() {
			return new Promise((resolve) => {
				server.closeAllConnections?.();
				server.close(resolve);
			});
		},
	};
	return handle.listen();
}
