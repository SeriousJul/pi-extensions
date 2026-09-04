/**
 * Watcher module: the watcher policy.
 *
 * Fast unit tests: no index build, no library. `startWatcher` is exercised
 * with a stub adapter: only the start result and the callback wiring are
 * under test, none of which touches a real index.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resetWslCache,
  startWatcher,
  WATCH_DEBOUNCE_MS,
  watchDisabledReason,
  type WatcherHooks,
} from "../../extensions/codegraph/watcher";
import type { IndexAdapter } from "../../extensions/codegraph/indexAdapter";
import { readMeta } from "../../extensions/codegraph/index-meta";

interface WatchOptions {
  debounceMs?: number;
  onDegraded?: (reason: string) => void;
  onSyncComplete?: (r: { filesChanged: number; durationMs: number }) => void;
  onSyncError?: () => void;
}

interface Stub {
  cg: IndexAdapter;
  options: () => WatchOptions | undefined;
}

/** A stand-in adapter: records the watch options, returns `result`. */
function stubWatch(result: boolean, dir: string, degradedReason?: string): Stub {
  let options: WatchOptions | undefined;
  const cg = {
    codeGraphDir: () => dir,
    watch: (opts: WatchOptions) => {
      options = opts;
      return result;
    },
    getWatcherDegradedReason: () => degradedReason,
  } as unknown as IndexAdapter;
  return { cg, options: () => options };
}

const noopHooks: WatcherHooks = {
  onDegraded: () => undefined,
  onSyncComplete: () => undefined,
};

let root: string;
let dir: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-watcher-"));
  // The meta record lives in the index directory; the stub reports it.
  dir = path.join(root, "index-dir");
  fs.mkdirSync(dir, { recursive: true });
  resetWslCache();
  delete process.env.CODEGRAPH_NO_WATCH;
  delete process.env.WSL_DISTRO_NAME;
  delete process.env.WSL_INTERACTIVE;
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  resetWslCache();
  delete process.env.CODEGRAPH_NO_WATCH;
  delete process.env.WSL_DISTRO_NAME;
  delete process.env.WSL_INTERACTIVE;
});

describe("disabled reasons", () => {
  it("CODEGRAPH_NO_WATCH=1 disables the watcher with the documented reason", () => {
    process.env.CODEGRAPH_NO_WATCH = "1";
    expect(watchDisabledReason(root)).toBe("CODEGRAPH_NO_WATCH=1");
    expect(startWatcher(stubWatch(true, dir).cg, root, noopHooks)).toEqual({
      state: "disabled",
      reason: "CODEGRAPH_NO_WATCH=1",
    });
  });

  it("WSL2 /mnt drives are detected from the documented env signals", () => {
    process.env.WSL_DISTRO_NAME = "ubuntu";
    expect(watchDisabledReason("/mnt/c/project")).toBe("WSL2 /mnt drive");
    // outside /mnt the watcher stays enabled
    expect(watchDisabledReason("/home/user/project")).toBeNull();

    resetWslCache();
    process.env.WSL_DISTRO_NAME = "";
    process.env.WSL_INTERACTIVE = "1";
    expect(watchDisabledReason("/mnt/d/project")).toBe("WSL2 /mnt drive");
  });

  it("no reason on a plain drive with no opt-out", () => {
    expect(watchDisabledReason(path.join(root, "proj"))).toBeNull();
  });
});

describe("startWatcher", () => {
  it("starts with the documented debounce and reports active", () => {
    const { cg, options } = stubWatch(true, dir);
    expect(startWatcher(cg, root, noopHooks)).toEqual({ state: "active" });
    expect(WATCH_DEBOUNCE_MS).toBe(1000);
    expect(options()!.debounceMs).toBe(WATCH_DEBOUNCE_MS);
  });

  it("the sync-complete callback writes the reconcile meta record", () => {
    const { cg, options } = stubWatch(true, dir);
    startWatcher(cg, root, noopHooks);
    options()!.onSyncComplete!({ filesChanged: 4, durationMs: 5 });
    const meta = readMeta(dir);
    expect(meta.lastReconcileAt).toBeTypeOf("number");
    expect(meta.lastReconcileChanged).toBe(4);
  });

  it("reports runtime degradation to the hook", () => {
    const { cg, options } = stubWatch(true, dir);
    const reasons: string[] = [];
    startWatcher(cg, root, {
      onDegraded: (r) => reasons.push(r),
      onSyncComplete: () => undefined,
    });
    options()!.onDegraded!("slow filesystem");
    expect(reasons).toEqual(["slow filesystem"]);
  });

  it("a thrown start degrades with the error message instead of throwing", () => {
    const cg = {
      codeGraphDir: () => dir,
      watch: () => {
        throw new Error("watch exploded");
      },
      getWatcherDegradedReason: () => undefined,
    } as unknown as IndexAdapter;
    expect(startWatcher(cg, root, noopHooks)).toEqual({
      state: "degraded",
      reason: "watch exploded",
    });
  });

  it("a false start falls back to the library's degraded reason", () => {
    const { cg } = stubWatch(false, dir, "no native watcher support");
    expect(startWatcher(cg, root, noopHooks)).toEqual({
      state: "degraded",
      reason: "no native watcher support",
    });
  });

  it("a false start without a reason degrades with the generic reason", () => {
    const { cg } = stubWatch(false, dir);
    expect(startWatcher(cg, root, noopHooks)).toEqual({
      state: "degraded",
      reason: "watcher failed to start",
    });
  });
});
