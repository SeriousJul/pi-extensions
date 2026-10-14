/**
 * No-op extension for the control run of the skill-tool e2e: it occupies
 * the extension slot so the control process is byte-for-byte the same run
 * minus the skill tool.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (_pi: ExtensionAPI): void {}
