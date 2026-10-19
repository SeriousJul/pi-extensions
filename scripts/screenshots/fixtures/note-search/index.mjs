/**
 * Capture-only fixture extension for the tool-headers screenshot (issue
 * #154).
 *
 * Registers one tool, note_search, with fixed arguments and fixed output.
 * The mock model calls it in the same turn as the real read and bash, so
 * the capture shows a directory-style extension row - tagged with its own
 * directory name, note-search - without the byte-unstable job id, pid, and
 * log path a real bash_bg row carries.
 *
 * It is plain ESM with no imports: the capture copies it to the fixed work
 * root, and the copy must load there, where no node_modules exists.
 */
export default function (pi) {
	pi.registerTool({
		name: "note_search",
		description: "Search the fixture notes.",
		parameters: {
			type: "object",
			properties: {
				query: { type: "string", description: "The note text to search for" },
			},
			required: ["query"],
		},
		async execute(_toolCallId, _params) {
		return {
			content: [{ type: "text", text: "1 note: tool row headers" }],
			details: {},
		};
	},
	});
}
