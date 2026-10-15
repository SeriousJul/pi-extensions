/**
 * The fake LSP server the client tests drive the seam with (ADR 0041).
 *
 * A real stdio JSON-RPC language server with a deterministic diagnostics
 * engine, so the tests never depend on a real server or on timing except
 * where the test opts in via FAKE_LSP_DELAY_MS.
 *
 * The diagnostics convention (used by the test fixtures): a line that
 * contains a marker gets one diagnostic for that line.
 *
 *   ERR:<message>   an error (severity 1) at the marker's position
 *   WARN:<message>  a warning (severity 2)
 *   INFO:<message>  an info (severity 3)
 *
 * Example: `let n = 1; // ERR:cannot find name 'x'` yields the error
 * `cannot find name 'x'` starting at the marker's column.
 *
 * Modes:
 *   (default)       push: publishes diagnostics after every
 *                   didOpen/didChange/didClose
 *   FAKE_LSP_PULL=1 pull: advertises diagnosticProvider and answers
 *                   textDocument/diagnostic on demand; never publishes
 *
 * Knobs (env):
 *   FAKE_LSP_DELAY_MS     milliseconds to wait before a publish (default 20)
 *   FAKE_LSP_SLOW_INIT_MS milliseconds to wait before answering initialize
 *   FAKE_LSP_CRASH_ON=<method>   crash (exit 137) right after answering
 *                                that method
 *   FAKE_LSP_HANG_REQUESTS=1     never answer textDocument/diagnostic
 *                                (exercises the per-request timeout)
 */
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";
import { DiagnosticSeverity } from "vscode-languageserver-protocol";

const connection = createMessageConnection(
	new StreamMessageReader(process.stdin),
	new StreamMessageWriter(process.stdout),
);

const DELAY_MS = Number(process.env.FAKE_LSP_DELAY_MS ?? "20");
const SLOW_INIT_MS = Number(process.env.FAKE_LSP_SLOW_INIT_MS ?? "0");
const CRASH_ON = process.env.FAKE_LSP_CRASH_ON ?? "";
const HANG_REQUESTS = process.env.FAKE_LSP_HANG_REQUESTS === "1";
const PULL = process.env.FAKE_LSP_PULL === "1";

/** uri -> latest full text (full-document sync). */
const documents = new Map();
/** uri -> last diagnostics published for it. */
const published = new Map();

function severityFor(marker) {
	if (marker === "ERR") return DiagnosticSeverity.Error;
	if (marker === "WARN") return DiagnosticSeverity.Warning;
	return DiagnosticSeverity.Information;
}

/** The deterministic diagnostics of a text, per the marker convention. */
function computeDiagnostics(text) {
	const out = [];
	const lines = text.split("\n");
	for (let line = 0; line < lines.length; line += 1) {
		const lineText = lines[line];
		for (const marker of ["ERR", "WARN", "INFO"]) {
			let index = lineText.indexOf(`${marker}:`);
			while (index !== -1) {
				const message = lineText.slice(index + marker.length + 1).trim();
				const end = Math.min(lineText.length, index + marker.length + 2);
				out.push({
					range: { start: { line, character: index }, end: { line, character: end } },
					severity: severityFor(marker),
					message,
				});
				index = lineText.indexOf(`${marker}:`, index + 1);
			}
		}
	}
	return out;
}

function publish(uri, text) {
	const diagnostics = computeDiagnostics(text ?? "");
	published.set(uri, diagnostics);
	setTimeout(() => {
		connection.sendNotification("textDocument/publishDiagnostics", { uri, diagnostics });
	}, DELAY_MS);
}

connection.onRequest("initialize", () => {
	return new Promise((resolve) => {
		setTimeout(() => {
			resolve({
				capabilities: {
					positionEncoding: "utf-16",
					textDocumentSync: { openClose: true, change: 1, save: false, documentSave: false },
					...(PULL
						? { diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false } }
						: {}),
				},
			});
		}, SLOW_INIT_MS);
	});
});

connection.onNotification("initialized", () => undefined);

connection.onNotification("textDocument/didOpen", (params) => {
	documents.set(params.textDocument.uri, params.textDocument.text);
	if (!PULL) publish(params.textDocument.uri, params.textDocument.text);
	if (CRASH_ON === "didOpen") process.exit(137);
});

connection.onNotification("textDocument/didChange", (params) => {
	const text = params.contentChanges?.[params.contentChanges.length - 1]?.text;
	if (text === undefined) return;
	documents.set(params.textDocument.uri, text);
	if (!PULL) publish(params.textDocument.uri, text);
	if (CRASH_ON === "didChange") process.exit(137);
});

connection.onNotification("textDocument/didClose", (params) => {
	documents.delete(params.textDocument.uri);
	if (!PULL) publish(params.textDocument.uri, undefined);
});

connection.onRequest("textDocument/diagnostic", (request) => {
	if (HANG_REQUESTS) return new Promise(() => undefined); // never responds
	return {
		kind: "full",
		items: computeDiagnostics(documents.get(request.textDocument.uri) ?? ""),
	};
});

connection.onRequest("textDocument/references", (request) => {
	const text = documents.get(request.textDocument.uri) ?? "";
	const lines = text.split("\n");
	const at = lines[request.position?.line];
	const needle = at?.slice(request.position?.character ?? 0, (request.position?.character ?? 0) + 5);
	const out = [];
	if (!needle) return out;
	for (let line = 0; line < lines.length; line += 1) {
		if (lines[line].includes(needle)) {
			out.push({ uri: request.textDocument.uri, range: { start: { line, character: lines[line].indexOf(needle) }, end: { line, character: lines[line].indexOf(needle) + needle.length } } });
		}
	}
	return out;
});

connection.onRequest("textDocument/hover", () => {
	return { contents: { kind: "markdown", value: "fake hover: the type of the symbol" } };
});

connection.onRequest("shutdown", () => undefined);
connection.onNotification("exit", () => process.exit(0));

connection.listen();
