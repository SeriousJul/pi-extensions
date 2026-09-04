/**
 * The reconcile lock-contention contract (spec 0003).
 *
 * `sync` reports a held per-root lock as an all-zero result - a real
 * no-change sync still reports how many files it checked - so
 * `filesChecked === 0` means the lock was not acquired. The contract:
 * retry twice on a 750 ms ramp, then return the last result. The caller
 * (the session) maps a final zero to the unavailable contract.
 *
 * Both Index adapters run their sync through this helper, so the contract
 * cannot drift between the real and the in-memory adapter. This module is
 * library-free on purpose: the in-memory test adapter imports it without
 * loading the codegraph library.
 */
import type { SyncResult } from "./indexAdapter";

/** The ramp between attempts: 750 ms, 1500 ms. */
export const SYNC_RETRY_SLEEP_MS = 750;
/** Two retries after the initial attempt: three syncs total. */
export const SYNC_RETRIES = 2;

export async function syncWithRetry(
  sync: () => Promise<SyncResult>,
  sleep: (ms: number) => Promise<void>,
): Promise<SyncResult> {
  let res: SyncResult;
  for (let attempt = 0; ; attempt++) {
    res = await sync();
    if (res.filesChecked > 0 || attempt >= SYNC_RETRIES) return res;
    await sleep(SYNC_RETRY_SLEEP_MS * (attempt + 1));
  }
}
