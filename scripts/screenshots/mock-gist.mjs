/**
 * Mock GitHub Gist API for the pi-sync status capture.
 *
 * Answers GET /gists/:id with a registered gist (the GitHub GistShape the
 * backend reads). Every other route is a 404, so an unexpected request
 * fails the capture loudly instead of returning silent content. No
 * request leaves the machine.
 */
import { createServer } from "node:http";

/**
 * Start the mock Gist API on a local port.
 * @returns {Promise<{port: number, register: (gist: {id: string}) => void, close: () => Promise<void>}>}
 */
export async function startMockGistServer() {
	const gists = {};
	const server = createServer((req, res) => {
		const match = /^\/gists\/([^/]+)$/.exec(req.url ?? "");
		if (req.method === "GET" && match && Object.hasOwn(gists, match[1])) {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify(gists[match[1]]));
			return;
		}
		res.writeHead(404, { "content-type": "application/json" });
		res.end(JSON.stringify({ message: `unknown route ${req.url}` }));
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = server.address().port;
	return {
		port,
		register(gist) {
			gists[gist.id] = gist;
		},
		close: () => new Promise((resolve) => server.close(resolve)),
	};
}
