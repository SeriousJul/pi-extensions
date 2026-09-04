/**
 * Watcher policy.
 *
 * codegraph's own file watcher keeps the index current between queries.
 * This module decides when the watcher runs at all (the disabled reasons),
 * starts it with the extension's options, and handles degradation: a
 * thrown start, the runtime onDegraded callback, and the library's
 * degraded-reason fallback. The sync-complete callback writes the
 * reconcile record through the index-meta module. The session keeps the
 * per-instance state and the one-time notifications.
 */
import fs from "node:fs";
import type { CodeGraph } from "./codegraph";
import { recordReconcile } from "./index-meta";

export type WatcherState = "active" | "degraded" | "disabled" | "off";

/** One sync per burst of file changes. */
export const WATCH_DEBOUNCE_MS = 1000;

let wslCache: boolean | undefined;
function isWsl(): boolean {
  if (wslCache === undefined) {
    wslCache = Boolean(
      process.env.WSL_DISTRO_NAME || process.env.WSL_INTERACTIVE,
    );
    if (!wslCache) {
      try {
        wslCache = /microsoft|wsl/i.test(
          fs.readFileSync("/proc/version", "utf-8"),
        );
      } catch {
        // not WSL
      }
    }
  }
  return wslCache;
}

/** Clear the WSL detection cache (for tests, so env changes take effect). */
export function resetWslCache(): void {
  wslCache = undefined;
}

/**
 * Mirrors codegraph's own watch policy: recursive fs.watch is pathologically
 * slow on WSL2 /mnt drives, and CODEGRAPH_NO_WATCH=1 opts out explicitly.
 */
export function watchDisabledReason(root: string): string | null {
  if (process.env.CODEGRAPH_NO_WATCH === "1") {
    return "CODEGRAPH_NO_WATCH=1";
  }
  if (isWsl() && root.startsWith("/mnt/")) {
    return "WSL2 /mnt drive";
  }
  return null;
}

/** The session's reactions to watcher events. */
export interface WatcherHooks {
  /** The watcher degraded at runtime with this reason. */
  onDegraded: (reason: string) => void;
  /**
   * A watcher sync finished; the reconcile meta record is already written.
   * `reconciledAt` is the timestamp the meta record stored.
   */
  onSyncComplete: (filesChanged: number, reconciledAt: number) => void;
}

/**
 * Start the index watcher. Never throws: a thrown start degrades instead
 * of failing a call that has already synced. Returns the resulting state
 * and, for `disabled` and `degraded`, the reason.
 */
export function startWatcher(
  cg: CodeGraph,
  root: string,
  hooks: WatcherHooks,
): { state: WatcherState; reason?: string } {
  const disabled = watchDisabledReason(root);
  if (disabled) {
    return { state: "disabled", reason: disabled };
  }
  // A thrown watch() (not just a false return) degrades the watcher;
  // it must not fail a tool call that has already synced.
  let ok: boolean;
  let startError: string | undefined;
  try {
    ok = cg.watch({
      debounceMs: WATCH_DEBOUNCE_MS,
      onDegraded: (reason: string) => hooks.onDegraded(reason),
      onSyncComplete: (r: { filesChanged: number; durationMs: number }) => {
        const at = recordReconcile(root, r.filesChanged);
        hooks.onSyncComplete(r.filesChanged, at);
      },
      onSyncError: () => {
        // transient sync errors are retried by the watcher
      },
    });
  } catch (err) {
    ok = false;
    startError = err instanceof Error ? err.message : String(err);
  }
  if (ok) return { state: "active" };
  const reason =
    startError ?? cg.getWatcherDegradedReason() ?? "watcher failed to start";
  return { state: "degraded", reason };
}
