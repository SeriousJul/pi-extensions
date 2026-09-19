/** A GitHub Gist document in the shape the pi-sync backend reads. */
export interface GistShape {
	id: string;
	files: Record<string, { filename?: string; content?: string; raw_url?: string }>;
	[key: string]: unknown;
}

/** The local mock of the GitHub Gist API. */
export interface MockGistServer {
	/** The local port the mock listens on. */
	port: number;
	/** Register a gist so GET /gists/<id> returns it. */
	register: (gist: GistShape) => void;
	close: () => Promise<void>;
}

/** Start the mock Gist API on a local port. No request leaves the box. */
export declare function startMockGistServer(): Promise<MockGistServer>;
