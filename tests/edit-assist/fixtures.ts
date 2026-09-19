/**
 * Unit fixtures for the Edit assist no-match Diagnosis.
 *
 * Every case is a real no-match failure extracted from pi session data
 * (~/.pi/agent/sessions): oldText is the exact text the model sent in the
 * failing edit call, and file is the contiguous old-side lines of the
 * retry edit's diff - the file text as it stood at the failure, with
 * regionStart..regionEnd naming the region the retry matched.
 */
export interface NoMatchFixture {
	name: string;
	/** The session file the case came from. */
	sourceSession: string;
	/** The file content at the moment of the failure (LF). */
	file: string;
	/** The oldText the model sent in the failing call. */
	oldText: string;
	/** A dummy replacement; a no-match failure never applies newText. */
	newText: string;
	/** The region the retry edit matched, 1-based and inclusive. */
	regionStart: number;
	regionEnd: number;
}

export const NO_MATCH_FIXTURES: NoMatchFixture[] = [
	{
		name: "leading-whitespace-drift",
		sourceSession: "2026-09-01T09-52-28-824Z_01a05c62-6a98-7edd-9fa0-7c5d6059e3f2.jsonl",
		file:
			"\t\t\t// The badge rides on the selected row at this width.\n" +
			"\t\t\texpect(setup.captureCharFrame()).toContain(\"[implement]\");\n" +
			"\n" +
			"\t\t\t// Shrink the terminal mid-session, across a width where the badge\n" +
			"\t\t\t// no longer fits.\n" +
			"\t\t\tsetup.resize(60, 12);\n" +
			"\t\t\tconst small = await awaitFrame(\n" +
			"\t\t\t\tsetup,\n" +
			"\t\t\t\t(f) =>\n" +
			"\t\t\t\t\trowsOf(f).length === 12 &&\n" +
			"\t\t\t\t\trowsOf(f).every((row) => row.length === 60) &&\n" +
			"\t\t\t\t\tf.includes(\"Tickets\") &&\n" +
			"\t\t\t\t\tf.includes(\"Detail\"),\n" +
			"\t\t\t\t\"the frame to take the new size\",\n" +
			"\t\t\t);\n" +
			"\t\t\t// Both panes and the selection survive the resize.\n" +
			"\t\t\texpect(small).toContain(\"Tickets\");\n",
		oldText:
			"\t\t// Shrink the terminal mid-session, across a width where the badge\n" +
			"\t\t// no longer fits.\n" +
			"\t\tsetup.resize(60, 12);\n" +
			"\t\tconst small = await awaitFrame(\n" +
			"\t\t\tsetup,\n" +
			"\t\t\t(f) =>\n" +
			"\t\t\t\trowsOf(f).length === 12 &&\n" +
			"\t\t\t\trowsOf(f).every((row) => row.length === 60) &&\n" +
			"\t\t\t\tf.includes(\"Tickets\") &&\n" +
			"\t\t\t\tf.includes(\"Detail\"),\n" +
			"\t\t\t\"the frame to take the new size\",\n" +
			"\t\t);",
		newText: "replacement",
		regionStart: 4,
		regionEnd: 15,
	},
	{
		name: "colon-brace-drift",
		sourceSession: "2026-09-10T19-03-29-642Z_01a08cb4-1e6a-75d4-bb07-4a902def137d.jsonl",
		file:
			"\tmessage,\n" +
			"\tonEmergencyExit,\n" +
			"}: OverridePanelProps) {\n" +
			"\tconst { width: terminalWidth, height: terminalHeight } = useTerminalDimensions();\n" +
			"\tconst [choice, setChoice] = useState<HandoffChoice>({ ...initial });\n" +
			"\t// The selection indexes the full row list, not the visible viewport. The\n" +
			"\t// viewport scrolls to keep this row on screen.\n" +
			"\tconst [selected, setSelected] = useState(0);\n",
		oldText:
			"): OverridePanelProps) {\n" +
			"\tconst { width: terminalWidth, height: terminalHeight } = useTerminalDimensions();\n" +
			"\tconst [choice, setChoice] = useState<HandoffChoice>({ ...initial });",
		newText: "replacement",
		regionStart: 3,
		regionEnd: 5,
	},
	{
		name: "brace-drift",
		sourceSession: "2026-09-01T10-05-36-908Z_01a05c6e-710c-7e4f-8e30-52253bf584fb.jsonl",
		file:
			"\t\t\t\t\t...(task.autoClose ? { \"auto-close\": true } : {}),\n" +
			"\t\t\t\t},\n" +
			"\t\t\t]),\n" +
			"\t\t),\n" +
			"\t\t\"auto-handoff\": config.autoHandoff,\n" +
			"\t\t\"max-parallel-agents\": config.maxParallelAgents,\n" +
			"\t\t\"agent-poll-interval-seconds\": config.agentPollIntervalSeconds,\n" +
			"\t\t\"completion-message-lines\": config.completionMessageLines,\n",
		oldText: "\t\t}),\n\t\t\"auto-handoff\": config.autoHandoff,\n\t\t\"max-parallel-agents\": config.maxParallelAgents,\n",
		newText: "replacement",
		regionStart: 4,
		regionEnd: 6,
	},
];
