/**
 * Backend registry: the manifest names the active Backend; this resolves the
 * name to the in-repo module that implements the seam. Adding a storage
 * target is a new module here; the merge and command logic never change.
 */
import { createGistBackend, GIST_BACKEND_NAME, type GistTransport } from "./backends/github-gist.ts";
import type { Backend, SyncManifest } from "./types.ts";

export interface BackendEnv {
	token: string;
	/** GitHub API base (Gist backend). Overridable for tests. */
	githubBaseUrl?: string;
	/** Transport override (Gist backend). Tests stub it. */
	transport?: GistTransport;
	signal?: AbortSignal;
}

export function createBackend(manifest: SyncManifest, env: BackendEnv, extra?: { gistId?: string }): { backend?: Backend; error?: string } {
	const options = manifest.backendOptions;
	switch (manifest.backend) {
		case GIST_BACKEND_NAME: {
			const gistId = extra?.gistId ?? (options.gistId ? options.gistId : undefined);
			return { backend: createGistBackend({ gistId, token: env.token, baseUrl: env.githubBaseUrl, transport: env.transport, signal: env.signal }) };
		}
		default:
			return { error: `unknown sync backend: ${manifest.backend} (the sync extension ships: ${GIST_BACKEND_NAME})` };
	}
}
