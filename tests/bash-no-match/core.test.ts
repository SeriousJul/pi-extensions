import { describe, expect, it } from "vitest";
import {
	classifyBashNoMatch,
	lastSegmentFirstWord,
	noOutputText,
	NO_MATCH_NOTE,
	SEARCH_COMMANDS,
} from "../../extensions/bash-no-match/core";
import { exitCodeFromText } from "../../extensions/bash-no-match/index";

const NO_OUTPUT_EXIT_1 = noOutputText(1);

describe("classifyBashNoMatch", () => {
	it("rewrites a bare rg with exit 1 and no output into a non-error with the note", () => {
		const rewrite = classifyBashNoMatch(1, NO_OUTPUT_EXIT_1, "rg nonexistent-token-zzz");
		expect(rewrite).toBeDefined();
		expect(rewrite!.isError).toBe(false);
		const text = rewrite!.content[0].text;
		expect(text.startsWith(NO_OUTPUT_EXIT_1)).toBe(true);
		expect(text).toContain(NO_MATCH_NOTE);
		// The rewritten result stays under 100 bytes, so the output-limits bound never cuts it.
		expect(text.length).toBeLessThan(100);
	});

	it("rewrites cd <dir> && rg with exit 1 and no output", () => {
		const rewrite = classifyBashNoMatch(1, NO_OUTPUT_EXIT_1, "cd crates/app && rg nonexistent-token-zzz");
		expect(rewrite).toBeDefined();
		expect(rewrite!.isError).toBe(false);
	});

	it("rewrites every search command in the allowlist", () => {
		for (const command of SEARCH_COMMANDS) {
			const rewrite = classifyBashNoMatch(1, NO_OUTPUT_EXIT_1, `${command} nothing`);
			expect(rewrite, command).toBeDefined();
		}
	});

	it("leaves echo hi && rg with output untouched", () => {
		const text = "hi\n\nCommand exited with code 1";
		expect(classifyBashNoMatch(1, text, "echo hi && rg nothing")).toBeNull();
	});

	it("leaves a grep whose stderr carried text untouched", () => {
		const text = "grep: /tmp/gone: No such file or directory\n\nCommand exited with code 1";
		expect(classifyBashNoMatch(1, text, "grep needle /tmp/gone")).toBeNull();
	});

	it("leaves cargo test exit 1 untouched", () => {
		const rewrite = classifyBashNoMatch(1, NO_OUTPUT_EXIT_1, "cargo test");
		expect(rewrite).toBeNull();
	});

	it("leaves a ; list untouched: the last && segment's first word is not a search", () => {
		expect(classifyBashNoMatch(1, NO_OUTPUT_EXIT_1, "cmd; rg nothing")).toBeNull();
	});

	it("leaves a subshell untouched", () => {
		expect(classifyBashNoMatch(1, NO_OUTPUT_EXIT_1, "(rg nothing)")).toBeNull();
	});

	it("leaves ls untouched: it is not in the allowlist", () => {
		expect(classifyBashNoMatch(1, NO_OUTPUT_EXIT_1, "ls /no/such/dir")).toBeNull();
	});

	it("leaves exit 2 untouched, whatever the text and command", () => {
		expect(classifyBashNoMatch(2, noOutputText(2), "rg nothing")).toBeNull();
	});

	it("leaves a mismatched exit code line untouched: the text and the exit code must agree on 1", () => {
		// The classifier takes the exit code and the text separately; the text
		// must be the exact no-output marker with the code 1 line.
		expect(classifyBashNoMatch(1, noOutputText(2), "rg nothing")).toBeNull();
	});

	it("leaves a successful search untouched", () => {
		expect(classifyBashNoMatch(0, "match on line 3", "rg needle")).toBeNull();
	});
});

describe("lastSegmentFirstWord", () => {
	it("treats a single command as a one-segment chain", () => {
		expect(lastSegmentFirstWord("rg foo bar")).toBe("rg");
	});

	it("takes the first word of the last && segment", () => {
		expect(lastSegmentFirstWord("cd src && cd app && grep -rn x .")).toBe("grep");
	});

	it("does not split ; lists or subshells", () => {
		// The first word keeps its punctuation: `cmd;` and `(rg` are not in the
		// search allowlist, so a ; list and a subshell never rewrite.
		expect(lastSegmentFirstWord("cmd; rg x")).toBe("cmd;");
		expect(lastSegmentFirstWord("(rg x)")).toBe("(rg");
	});

	it("returns an empty string for an empty command", () => {
		expect(lastSegmentFirstWord("")).toBe("");
		expect(lastSegmentFirstWord("   \t  ")).toBe("");
	});
});

describe("exitCodeFromText", () => {
	it("reads the exit code line", () => {
		expect(exitCodeFromText(`(no output)\n\nCommand exited with code 1`)).toBe(1);
		expect(exitCodeFromText("boom\n\nCommand exited with code 2")).toBe(2);
	});

	it("yields null when the text carries no exit code line", () => {
		expect(exitCodeFromText("(no output)")).toBeNull();
		expect(exitCodeFromText("ok")).toBeNull();
	});
});
