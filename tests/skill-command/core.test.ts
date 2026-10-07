import { describe, expect, it } from "vitest";
import { normalizeSkillCommand } from "../../extensions/skill-command/core";

// The reported bug (issue #126): an injected skill command separates the
// skill name from the arguments with a newline, e.g. the factory's
// consultation templates start with "/skill:grill-with-docs\n\n<body>".
// pi's built-in expansion parses the name up to the FIRST SPACE, so with a
// newline separator the parsed "name" is "grill-with-docs\n\nYou" - nothing
// matches, and the command passes through unexpanded. The extension's input
// handler normalizes the separator to the single space pi parses, so the
// built-in expansion runs. These tests pin the normalization: only the
// separator changes, the arguments stay byte-identical, and no other input
// is touched.

describe("normalizeSkillCommand", () => {
	it("replaces a newline separator with a single space, keeping the args verbatim", () => {
		const body = "You are grilling the specification.\n\n### Rules\n\n1. First rule";
		expect(normalizeSkillCommand(`/skill:grill-with-docs\n\n${body}`)).toBe(
			`/skill:grill-with-docs You are grilling the specification.\n\n### Rules\n\n1. First rule`,
		);
	});

	it("normalizes a CRLF separator", () => {
		expect(normalizeSkillCommand("/skill:loop-fixture\r\nDo the thing.")).toBe(
			"/skill:loop-fixture Do the thing.",
		);
	});

	it("normalizes a separator with spaces around the newline", () => {
		expect(normalizeSkillCommand("/skill:loop-fixture  \n \tDo the thing.")).toBe(
			"/skill:loop-fixture Do the thing.",
		);
	});

	it("drops a trailing newline when there are no arguments", () => {
		expect(normalizeSkillCommand("/skill:loop-fixture\n")).toBe("/skill:loop-fixture");
	});

	it("drops a trailing CRLF plus spaces when there are no arguments", () => {
		expect(normalizeSkillCommand("/skill:loop-fixture\r\n   ")).toBe("/skill:loop-fixture");
	});

	it("treats whitespace-only arguments as none", () => {
		expect(normalizeSkillCommand("/skill:loop-fixture\n\n")).toBe("/skill:loop-fixture");
	});

	it("does not touch a space-separated command (pi already expands it)", () => {
		expect(normalizeSkillCommand("/skill:loop-fixture Do the thing.")).toBeUndefined();
	});

	it("does not touch a bare skill command", () => {
		expect(normalizeSkillCommand("/skill:loop-fixture")).toBeUndefined();
	});

	it("does not touch a command with an invalid (uppercase) name", () => {
		expect(normalizeSkillCommand("/skill:Loop-Fixture\nDo the thing.")).toBeUndefined();
	});

	it("does not touch other slash commands", () => {
		expect(normalizeSkillCommand("/compact\nsummarize")).toBeUndefined();
		expect(normalizeSkillCommand("/model openai/gpt-5.2\n")).toBeUndefined();
	});

	it("does not touch a skill command that is not at the start of the text", () => {
		expect(normalizeSkillCommand("Please run /skill:loop-fixture\nnow")).toBeUndefined();
	});

	it("does not touch a tab-only separator", () => {
		expect(normalizeSkillCommand("/skill:loop-fixture\tDo the thing.")).toBeUndefined();
	});

	it("keeps a later /skill: mention in the arguments untouched", () => {
		const input = "/skill:loop-fixture\n\nThen run /skill:other\nand stop.";
		expect(normalizeSkillCommand(input)).toBe(
			"/skill:loop-fixture Then run /skill:other\nand stop.",
		);
	});

	it("returns undefined for empty and non-command text", () => {
		expect(normalizeSkillCommand("")).toBeUndefined();
		expect(normalizeSkillCommand("Just a message.\n\nWith lines.")).toBeUndefined();
		expect(normalizeSkillCommand("/skill:\nno name here")).toBeUndefined();
	});
});
