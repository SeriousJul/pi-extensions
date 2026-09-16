/**
 * The settings writer.
 *
 * Builds a fresh native settings manager per operation, applies the state
 * machine's output, and flushes the file before returning. Only the arrays
 * the operation itself changed (prev to next) are marked modified, and the
 * native writer merges those into a fresh file read under a lock. So
 * concurrent pi sessions never clobber each other's pattern entries: a
 * session's own later saves cannot overwrite an entry this writer did not
 * touch, and vice versa.
 *
 * Project-scope writes go through the native trust assertion; the error is
 * surfaced, not retried.
 */
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { SettingsState } from "./types.ts";

export interface WriteOptions {
  cwd: string;
  agentDir: string;
  /** The trust state of the running session; untrusted refuses project writes. */
  projectTrusted: boolean;
}

export interface WriteOutcome {
  ok: boolean;
  /** The failure, when the write was refused or the file could not be saved. */
  error?: string;
}

const sameArray = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

const trustedRefusal = (message: string): string =>
  message.includes("not trusted")
    ? `Project is not trusted; trust the project first, then retry. (${message})`
    : message;

/**
 * Apply the diff between prev and next to the settings files and flush.
 * prev is the state the operation started from; next is the state machine's
 * output. Arrays equal in prev and next are not touched, even if a
 * concurrent session changed them on disk in the meantime.
 */
export async function writeSettings(
  options: WriteOptions,
  prev: SettingsState,
  next: SettingsState,
): Promise<WriteOutcome> {
  const manager = SettingsManager.create(options.cwd, options.agentDir, {
    projectTrusted: options.projectTrusted,
  });

  try {
    if (!sameArray(prev.global.extensions, next.global.extensions)) {
      manager.setExtensionPaths(next.global.extensions);
    }
    if (!sameArray(prev.global.skills, next.global.skills)) {
      manager.setSkillPaths(next.global.skills);
    }
    if (!sameArray(prev.global.prompts, next.global.prompts)) {
      manager.setPromptTemplatePaths(next.global.prompts);
    }
    if (!sameArray(prev.global.themes, next.global.themes)) {
      manager.setThemePaths(next.global.themes);
    }
    if (!sameArray(prev.project.extensions, next.project.extensions)) {
      manager.setProjectExtensionPaths(next.project.extensions);
    }
    if (!sameArray(prev.project.skills, next.project.skills)) {
      manager.setProjectSkillPaths(next.project.skills);
    }
    if (!sameArray(prev.project.prompts, next.project.prompts)) {
      manager.setProjectPromptTemplatePaths(next.project.prompts);
    }
    if (!sameArray(prev.project.themes, next.project.themes)) {
      manager.setProjectThemePaths(next.project.themes);
    }
  } catch (error) {
    return { ok: false, error: trustedRefusal(error instanceof Error ? error.message : String(error)) };
  }

  await manager.flush();
  const errors = manager.drainErrors();
  if (errors.length > 0) {
    const first = errors[0];
    const detail = first?.error instanceof Error ? first.error.message : String(first);
    return { ok: false, error: trustedRefusal(detail) };
  }
  return { ok: true };
}
