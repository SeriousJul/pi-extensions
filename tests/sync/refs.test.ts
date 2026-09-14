import { describe, expect, it } from "vitest";

import { scanReferences } from "../../extensions/sync/refs.ts";
import { sha256Hex } from "../../extensions/sync/hash.ts";
import type { SyncFile } from "../../extensions/sync/types.ts";

function md(path: string, content: string): SyncFile {
	return { path, content, mtimeMs: 0, hash: sha256Hex(content) };
}

describe("reference scanner", () => {
	it("stays quiet when home references resolve into the snapshot", () => {
		const files = [md("AGENTS.md", "See ~/OPINIONS.md and ~/VOICE.md for tone."), md("OPINIONS.md", "x"), md("VOICE.md", "y")];
		expect(scanReferences(files)).toEqual([]);
	});

	it("warns when a home reference points outside the snapshot", () => {
		const files = [md("AGENTS.md", "Read ~/NOTES.md before posting."), md("OPINIONS.md", "x")];
		const warnings = scanReferences(files);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toMatchObject({ file: "AGENTS.md", target: "~/NOTES.md", resolved: "NOTES.md" });
	});

	it("resolves relative markdown links against the file's directory", () => {
		const files = [
			md("extensions/skills/x/SKILL.md", "Details in [the reporting flow](reporting.md)."),
			md("extensions/skills/x/reporting.md", "flow"),
		];
		expect(scanReferences(files)).toEqual([]);
	});

	it("warns on a dangling relative link", () => {
		const files = [md("extensions/skills/x/SKILL.md", "Details in [the reporting flow](reporting.md).")];
		const warnings = scanReferences(files);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toMatchObject({ file: "extensions/skills/x/SKILL.md", resolved: "extensions/skills/x/reporting.md" });
	});

	it("treats a link to a snapshot directory as covered", () => {
		const files = [md("AGENTS.md", "Docs in [the adr directory](docs/adr)."), md("docs/adr/0001-x.md", "adr")];
		expect(scanReferences(files)).toEqual([]);
	});

	it("ignores URLs, anchors, mailto, and bare words", () => {
		const files = [
			md(
				"AGENTS.md",
				"See [github](https://github.com/x/y), [top](#section), [mail](mailto:a@b.c), and [docs](https://pi.dev/docs) for more.",
			),
		];
		expect(scanReferences(files)).toEqual([]);
	});

	it("ignores non-markdown files", () => {
		const files = [
			{ path: ".pi/agent/settings.json", content: "see ~/NOTES.md", mtimeMs: 0, hash: sha256Hex("x") },
			{ path: "AGENTS.md", content: "clean", mtimeMs: 0, hash: sha256Hex("y") },
		];
		expect(scanReferences(files)).toEqual([]);
	});

	it("reports each dangling resolved path once per file", () => {
		const files = [md("AGENTS.md", "See ~/NOTES.md and ~/NOTES.md again, plus [one](NOTES.md).")];
		const warnings = scanReferences(files);
		// All three references resolve to the same missing path; dedup is per
		// (file, resolved path), so the user gets one warning, not three.
		expect(warnings.map((w) => w.resolved)).toEqual(["NOTES.md"]);
	});

	it("handles relative links with anchors and titles", () => {
		const files = [md("AGENTS.md", "See [the spec](docs/spec.md#merge \"Merge rules\")."), md("docs/spec.md", "spec")];
		expect(scanReferences(files)).toEqual([]);
	});
});
