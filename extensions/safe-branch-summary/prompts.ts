/**
 * Verbatim copies of pi's branch-summarization prompt text and file-section
 * formatting, taken from @earendil-works/pi-coding-agent 0.86.1
 * (packages/coding-agent/src/core/compaction/branch-summarization.ts and
 * compaction/utils.ts). pi does not export these, so the extension copies
 * them. Drift from a later upstream change is cosmetic: the format stays
 * model-readable.
 */
import type { FileOperations } from "@earendil-works/pi-coding-agent";

/** The pi version these copies were taken from. */
export const PI_SOURCE_VERSION = "0.86.1";

/** Verbatim from pi 0.86.1 compaction/utils.ts. */
export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

/** Verbatim from pi 0.86.1 branch-summarization.ts. */
export const BRANCH_SUMMARY_PREAMBLE = `The user explored a different conversation branch before returning here.
Summary of that exploration:

`;

/** Verbatim from pi 0.86.1 branch-summarization.ts. */
export const BRANCH_SUMMARY_PROMPT = `Create a structured summary of this conversation branch for context when returning later.

Use this EXACT format:

## Goal
[What was the user trying to accomplish in this branch?]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Work that was started but not finished]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [What should happen next to continue this work]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

/** Verbatim from pi 0.86.1 compaction/utils.ts. */
export function computeFileLists(fileOps: FileOperations): { readFiles: string[]; modifiedFiles: string[] } {
	const modified = new Set([...fileOps.edited, ...fileOps.written]);
	const readOnly = [...fileOps.read].filter((f) => !modified.has(f)).sort();
	const modifiedFiles = [...modified].sort();
	return { readFiles: readOnly, modifiedFiles };
}

/** Verbatim from pi 0.86.1 compaction/utils.ts. */
export function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
	const sections = [];
	if (readFiles.length > 0) {
		sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
	}
	if (modifiedFiles.length > 0) {
		sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
	}
	if (sections.length === 0) return "";
	return `\n\n${sections.join("\n\n")}`;
}
