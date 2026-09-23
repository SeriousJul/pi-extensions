/**
 * Safe branch summary core.
 *
 * The pure decision module behind the Safe branch summary extension
 * (ADR 0025). Given the abandoned branch's entries, the session model, and
 * the settings, it decides whether to summarize, at what budget, and what
 * the standalone request prompt is. It has no pi process in it: pi's
 * exported entry preparation does the selection, so the newest-first
 * semantics and the compaction-and-branch-summary carry rule stay exactly
 * the built-in's.
 *
 * Budget math: safe budget = (Effective window - pi's reserve) / Inflation
 * factor. pi's own budget is Effective window - reserve measured in the
 * chars/4 estimate; code content tokenizes up to about 1.85x denser than
 * that estimate, so dividing by the factor (default 2.0) keeps the real
 * request inside the window the server serves.
 */
import { convertToLlm, prepareBranchEntries, serializeConversation } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	BRANCH_SUMMARY_PREAMBLE,
	BRANCH_SUMMARY_PROMPT,
	SUMMARIZATION_SYSTEM_PROMPT,
	computeFileLists,
	formatFileOperations,
} from "./prompts.ts";

/** Hard cap on summary output, the same as the built-in's. */
export const MAX_SUMMARY_OUTPUT_TOKENS = 4096;

export interface SafeBranchSummaryInput {
	/** The abandoned branch's entries, in chronological order. */
	entries: SessionEntry[];
	/** The session model's effective context window (healed and clamped). */
	contextWindow: number | undefined;
	/** The session model's maximum output tokens. */
	maxOutputTokens: number | undefined;
	/** pi's branchSummary.reserveTokens, read from pi's own settings. */
	reserveTokens: number;
	/** The Inflation factor from the extension settings. */
	inflationFactor: number;
	/** Optional custom focus instructions for the summarizer. */
	customInstructions?: string;
	/** If true, customInstructions replaces the default prompt instead of being appended. */
	replaceInstructions?: boolean;
}

export type SafeBranchSummaryDecision =
	| {
			/** The branch is empty: pi writes no entry, and the extension adds none. */
			kind: "no-branch";
	  }
	| {
			/** The branch has entries but none fit the budget: write the built-in's degenerate entry. */
			kind: "no-content";
	  }
	| {
			/** The window cannot serve the request: soft-skip with a notice. */
			kind: "soft-skip";
			notice: string;
	  }
	| {
			kind: "summarize";
			/** The safe budget in pi's estimated tokens. */
			budgetTokens: number;
			/** System prompt for the standalone request. */
			systemPrompt: string;
			/** The single user message body of the request. */
			userText: string;
			/** Output cap for the request. */
			maxTokens: number;
			/** Files read by the selected content. */
			readFiles: string[];
			/** Files modified by the selected content. */
			modifiedFiles: string[];
	  };

/** The built-in's degenerate entry text for a non-empty branch with no fitting content. */
export const NO_CONTENT_SUMMARY = "No content to summarize";

/** Decide how the Safe branch summary handles one navigation. */
export function decideSafeBranchSummary(input: SafeBranchSummaryInput): SafeBranchSummaryDecision {
	if (input.entries.length === 0) {
		return { kind: "no-branch" };
	}
	const window = input.contextWindow;
	if (window === undefined || !Number.isFinite(window)) {
		return { kind: "soft-skip", notice: "the session model reports no context window; no branch summary written" };
	}
	if (window <= input.reserveTokens) {
		return {
			kind: "soft-skip",
			notice: `effective window ${window} is at or below the reserved margin ${input.reserveTokens}; no branch summary written`,
		};
	}
	const budgetTokens = Math.floor((window - input.reserveTokens) / input.inflationFactor);
	if (budgetTokens <= 0) {
		return {
			kind: "soft-skip",
			notice: `safe budget for window ${window} and margin ${input.reserveTokens} is zero; no branch summary written`,
		};
	}
	const { messages, fileOps } = prepareBranchEntries(input.entries, budgetTokens);
	if (messages.length === 0) {
		return { kind: "no-content" };
	}
	// Serialize the prepared messages to text: this prevents the model from
	// treating the branch as a conversation to continue. Same pipeline the
	// built-in uses.
	const conversationText = serializeConversation(convertToLlm(messages));
	// Build the instructions with the built-in's exact variants: replace,
	// append, or default.
	let instructions: string;
	if (input.replaceInstructions && input.customInstructions) {
		instructions = input.customInstructions;
	} else if (input.customInstructions) {
		instructions = `${BRANCH_SUMMARY_PROMPT}\n\nAdditional focus: ${input.customInstructions}`;
	} else {
		instructions = BRANCH_SUMMARY_PROMPT;
	}
	const userText = `<conversation>\n${conversationText}\n</conversation>\n\n${instructions}`;
	const maxTokens = Math.min(
		MAX_SUMMARY_OUTPUT_TOKENS,
		input.maxOutputTokens !== undefined && input.maxOutputTokens > 0 ? input.maxOutputTokens : Number.POSITIVE_INFINITY,
	);
	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	return {
		kind: "summarize",
		budgetTokens,
		systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
		userText,
		maxTokens,
		readFiles,
		modifiedFiles,
	};
}

/**
 * Assemble the persisted summary text from the model output: the branch
 * preamble, the model's structured summary, then the read and modified
 * file sections. The built-in's exact shape.
 */
export function finalizeBranchSummary(modelText: string, readFiles: string[], modifiedFiles: string[]): string {
	let summary = BRANCH_SUMMARY_PREAMBLE + modelText;
	summary += formatFileOperations(readFiles, modifiedFiles);
	return summary || "No summary generated";
}
