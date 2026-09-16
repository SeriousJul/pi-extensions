/**
 * Turn serializer (pure): one finished turn to the compression model's
 * input text.
 *
 * pi's role-labeled conversation serializer (the one compaction feeds its
 * summarizer) produces the input. Tool results are pre-cut to head + tail,
 * 2000 characters total, before serialization: pi's own cut is head-only,
 * and a failure's last lines (the actual error) are the useful part, so
 * failure results get the same head-plus-tail cut. A result whose full text
 * fits the budget (most failures) reaches the model verbatim; pi's own
 * cut only ever fires on text longer than the budget.
 */
import { serializeConversation } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message, ToolResultMessage } from "@earendil-works/pi-ai";

/** One tool result's cut budget: head + tail, 2000 characters total. */
export const TOOL_RESULT_MAX_CHARS = 2000;

function isLlmMessage(message: AgentMessage): message is Message {
	return message.role === "user" || message.role === "assistant" || message.role === "toolResult";
}

/** Cut a tool result's text to head + tail within `maxChars` total. The
 * marker says how many middle characters were cut. */
export function cutToolResultText(text: string, maxChars: number = TOOL_RESULT_MAX_CHARS): string {
	if (text.length <= maxChars) return text;
	const cut = text.length - maxChars;
	const marker = `\n[... ${cut} middle characters cut]...\n`;
	const keep = Math.max(0, maxChars - marker.length);
	const head = Math.ceil(keep / 2);
	const tail = Math.floor(keep / 2);
	return text.slice(0, head) + marker + text.slice(text.length - tail);
}

function prepare(message: Message): Message {
	if (message.role !== "toolResult") return message;
	const toolResult = message as ToolResultMessage;
	return {
		...toolResult,
		content: toolResult.content.map((block) =>
			block.type === "text" ? { ...block, text: cutToolResultText(block.text) } : block,
		),
	};
}

/** One finished turn to the compression model's input text. */
export function serializeTurn(messages: AgentMessage[]): string {
	return serializeConversation(messages.filter(isLlmMessage).map(prepare));
}
