import { describe, expect, it } from "vitest";
import { isQuotaHaltError } from "../../extensions/model-router/classifier";

describe("isQuotaHaltError", () => {
	it("matches the observed openai-codex WebSocket shape", () => {
		expect(isQuotaHaltError("Codex error: The usage limit has been reached")).toBe(true);
	});

	it("matches the openai-codex HTTP rewrite shape", () => {
		expect(isQuotaHaltError("You have hit your ChatGPT usage limit (plus plan). Try again in ~22 min.")).toBe(
			true,
		);
	});

	it.each([
		"GoUsageLimitError",
		"FreeUsageLimitError",
		"Monthly usage limit reached",
		"available balance",
		"insufficient_quota",
		"quota exceeded",
		"out of budget",
		"billing error",
	])("matches pi's generic terminal pattern %j", (text) => {
		expect(isQuotaHaltError(text)).toBe(true);
	});

	it("is case-insensitive", () => {
		expect(isQuotaHaltError("USAGE LIMIT HAS BEEN REACHED")).toBe(true);
	});

	it("does not match transient throttles or overloads", () => {
		expect(isQuotaHaltError("Our servers are currently overloaded. Please try again later.")).toBe(false);
		expect(isQuotaHaltError("rate limited, retry in 30s")).toBe(false);
		expect(isQuotaHaltError("Too many requests")).toBe(false);
	});

	it("does not match context overflow", () => {
		expect(isQuotaHaltError("prompt is too long: 210000 tokens > 200000 maximum")).toBe(false);
	});

	it("does not match expired-token 401s", () => {
		expect(isQuotaHaltError("401 Unauthorized: token expired")).toBe(false);
	});

	it("does not match empty or null text", () => {
		expect(isQuotaHaltError("")).toBe(false);
		expect(isQuotaHaltError(undefined)).toBe(false);
		expect(isQuotaHaltError(null)).toBe(false);
	});

	it("does not match an ordinary error", () => {
		expect(isQuotaHaltError("connection refused")).toBe(false);
	});
});
