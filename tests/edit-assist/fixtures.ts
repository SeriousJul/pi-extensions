/**
 * Fixture helpers: the stock argument-validation error exactly as pi's own
 * validator produces it. The call goes through pi's real prepareArguments
 * and validateToolArguments, so the error text is byte-identical to what a
 * real session records.
 */
import type { Tool } from "@earendil-works/pi-ai";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { createEditTool } from "@earendil-works/pi-coding-agent";

type FixtureEditTool = Tool & { prepareArguments?: (args: unknown) => unknown };

let editTool: FixtureEditTool | null = null;

/** The stock validation error for one raw edit call argument object. */
export function realValidationError(args: unknown): string {
	editTool ??= createEditTool(process.cwd()) as unknown as FixtureEditTool;
	const prepared = editTool.prepareArguments ? editTool.prepareArguments(structuredClone(args)) : args;
	try {
		validateToolArguments(editTool, { type: "toolCall", id: "fixture", name: "edit", arguments: prepared as Record<string, any> });
		throw new Error(`expected validation to fail for ${JSON.stringify(args)}`);
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("expected validation to fail")) throw error;
		return (error as Error).message;
	}
}
