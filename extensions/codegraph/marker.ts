/**
 * The cross-process build marker.
 *
 * `<root>/.codegraph/pi-codegraph-build.json` announces that a process is
 * building or seeding the index for `root`: its pid, the start time, and
 * the mode. A process that finds a live peer's marker waits for the build;
 * one that finds a dead marker (its process is gone) removes the file and
 * adopts the on-disk state. The marker is written under codegraph's
 * per-root file lock and cleared when the build or seed ends.
 */
import fs from "node:fs";
import path from "node:path";
import { getCodeGraphDir } from "./runtime";

/** Exported for tests that simulate another process's live build. */
export const MARKER_NAME = "pi-codegraph-build.json";

export type BuildMode = "build" | "seed";

export interface BuildMarker {
  pid: number;
  startedAt: number;
  mode: BuildMode;
}

/** Thrown when the build wait exceeds its timeout. */
export class BuildWaitTimeout extends Error {
  constructor() {
    super("timed out waiting for another codegraph process to finish the index");
    this.name = "BuildWaitTimeout";
  }
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export function markerPath(root: string): string {
  return path.join(getCodeGraphDir(root), MARKER_NAME);
}

/** A missing or malformed file reads as no marker. */
export function readMarker(root: string): BuildMarker | undefined {
  let marker: BuildMarker | undefined;
  try {
    marker = JSON.parse(
      fs.readFileSync(markerPath(root), "utf-8"),
    ) as BuildMarker;
  } catch {
    return undefined;
  }
  return marker && typeof marker.pid === "number" ? marker : undefined;
}

/**
 * Write the marker for `pid` (this process by default; tests pass a peer's
 * pid to simulate another process's build).
 */
export function writeMarker(
  root: string,
  mode: BuildMode,
  pid: number = process.pid,
): void {
  fs.writeFileSync(
    markerPath(root),
    JSON.stringify({ pid, startedAt: Date.now(), mode }),
  );
}

export function clearMarker(root: string): void {
  fs.rmSync(markerPath(root), { force: true });
}

/** Signal-0 probe: true when `pid` is alive (including another user's). */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** True when the marker belongs to a live process other than this one. */
export function isLivePeer(marker: BuildMarker): boolean {
  return marker.pid !== process.pid && isPidAlive(marker.pid);
}

/**
 * True when a build is in flight: one started by this process (its own
 * marker) or by a live peer.
 */
export function isBuildInFlight(marker: BuildMarker): boolean {
  return marker.pid === process.pid || isPidAlive(marker.pid);
}

/**
 * Block while another live process is building the index for `root` (its
 * marker is present). A marker whose process is dead is removed and the
 * on-disk state is adopted instead. `onStatus` reports the wait on each
 * poll. Throws BuildWaitTimeout when the wait exceeds `timeoutMs`.
 */
export async function waitForBuild(
  root: string,
  opts: {
    timeoutMs: number;
    pollMs?: number;
    onStatus?: (text: string) => void;
  },
): Promise<void> {
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    const marker = readMarker(root);
    if (!marker) return;
    if (marker.pid !== process.pid && !isPidAlive(marker.pid)) {
      clearMarker(root);
      return;
    }
    opts.onStatus?.(
      `codegraph: waiting for the index build at ${root} (pid ${marker.pid})`,
    );
    if (Date.now() > deadline) throw new BuildWaitTimeout();
    await sleep(opts.pollMs ?? 300);
  }
}
