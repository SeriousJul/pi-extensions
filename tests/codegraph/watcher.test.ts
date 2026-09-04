/**
 * Watcher module: the watcher policy.
 *
 * Fast unit tests: no index build. `startWatcher` is exercised with a stub
 * CodeGraph: only the start result and the callback wiring are under test,
 * none of which touches a real index.
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
import type { CodeGraph } from "../../extensions/codegraph/runtime";
import { readMeta } from "../../extensions/codegraph/index-meta";
import { getCodeGraphDir } from "../../extensions/codegraph/runtime";

interface WatchOptions {
  debounceMs?: number;
  onDegraded?: (reason: string) => void;
  onSyncComplete?: (r: { filesChanged: number; durationMs: number }) => void;
  onSyncError?: () => void;
}

interface Stub {
  cg: CodeGraph;
  options: () => WatchOptions | undefined;
}

/** A stand-in CodeGraph: records the watch options, returns `result`. */
function stubWatch(result: boolean, degradedReason?: string): Stub {
  let options: WatchOptions | undefined;
  const cg = {
    watch: (opts: WatchOptions) => {
      options = opts;
      return result;
    },
    getWatcherDegradedReason: () => degradedReason,
  } as unknown as CodeGraph;
  return { cg, options: () => options };
}

const noopHooks: WatcherHooks = {
  onDegraded: () => undefined,
  onSyncComplete: () => undefined,
};

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-watcher-"));
  fs.mkdirSync(getCodeGraphDir(root), { recursive: true });
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
    expect(startWatcher(stubWatch(true).cg, root, noopHooks)).toEqual({
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
    const { cg, options } = stubWatch(true);
    expect(startWatcher(cg, root, noopHooks)).toEqual({ state: "active" });
    expect(WATCH_DEBOUNCE_MS).toBe(1000);
    expect(options()!.debounceMs).toBe(WATCH_DEBOUNCE_MS);
  });

  it("the sync-complete callback writes the reconcile meta record", () => {
    const { cg, options } = stubWatch(true);
    startWatcher(cg, root, noopHooks);
    options()!.onSyncComplete!({ filesChanged: 4, durationMs: 5 });
    const meta = readMeta(root);
    expect(meta.lastReconcileAt).toBeTypeOf("number");
    expect(meta.lastReconcileChanged).toBe(4);
  });

  it("reports runtime degradation to the hook", () => {
    const { cg, options } = stubWatch(true);
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
      watch: () => {
        throw new Error("watch exploded");
      },
      getWatcherDegradedReason: () => undefined,
    } as unknown as CodeGraph;
    expect(startWatcher(cg, root, noopHooks)).toEqual({
      state: "degraded",
      reason: "watch exploded",
    });
  });

  it("a false start falls back to the library's degraded reason", () => {
    const { cg } = stubWatch(false, "no native watcher support");
    expect(startWatcher(cg, root, noopHooks)).toEqual({
      state: "degraded",
      reason: "no native watcher support",
    });
  });

  it("a false start without a reason degrades with the generic reason", () => {
    const { cg } = stubWatch(false);
    expect(startWatcher(cg, root, noopHooks)).toEqual({
      state: "degraded",
      reason: "watcher failed to start",
    });
  });
});
