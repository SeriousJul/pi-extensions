import { ANSWER, helper } from "./shared";

export function formatReport(x: number): string {
	return `value=${helper(x)} answer=${ANSWER}`;
}
