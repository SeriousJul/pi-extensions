/**
 * Marker module: the cross-process build marker contract.
 *
 * Fast unit tests: no index build, no library. A plain temporary directory
 * stands in for the index directory (the module takes the directory, not
 * the root - the layout belongs to the Index adapter, spec 0003).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BuildWaitTimeout,
  clearMarker,
  isBuildInFlight,
  isLivePeer,
  isPidAlive,
  MARKER_NAME,
  markerPath,
  readMarker,
  waitForBuild,
  writeMarker,
} from "../../extensions/codegraph/marker";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-marker-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A pid whose process has exited: the marker it owned reads as dead. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  return child.pid!;
}

describe("marker file", () => {
  it("reads as absent when the file is missing", () => {
    expect(readMarker(dir)).toBeUndefined();
  });

  it("round-trips write, read, and clear", () => {
    writeMarker(dir, "seed");
    const marker = readMarker(dir);
    expect(marker?.pid).toBe(process.pid);
    expect(marker?.startedAt).toBeTypeOf("number");
    expect(marker?.mode).toBe("seed");
    clearMarker(dir);
    expect(readMarker(dir)).toBeUndefined();
  });

  it("writes under the documented name in the index directory", () => {
    writeMarker(dir, "build");
    expect(markerPath(dir)).toBe(path.join(dir, MARKER_NAME));
    expect(fs.existsSync(markerPath(dir))).toBe(true);
  });

  it("reads a malformed file as absent", () => {
    fs.writeFileSync(markerPath(dir), "not json");
    expect(readMarker(dir)).toBeUndefined();
    fs.writeFileSync(markerPath(dir), JSON.stringify({ startedAt: 1 }));
    expect(readMarker(dir)).toBeUndefined();
  });
});

describe("pid liveness", () => {
  it("reads a dead pid as dead", async () => {
    const pid = await deadPid();
    expect(isPidAlive(pid)).toBe(false);
    writeMarker(dir, "build", pid);
    const marker = readMarker(dir)!;
    expect(isLivePeer(marker)).toBe(false);
    expect(isBuildInFlight(marker)).toBe(false);
  });

  it("reads this process and a spawned peer as live", () => {
    expect(isPidAlive(process.pid)).toBe(true);
    writeMarker(dir, "build");
    const own = readMarker(dir)!;
    expect(isBuildInFlight(own)).toBe(true);
    expect(isLivePeer(own)).toBe(false); // its own marker is not a peer

    const peer = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      expect(isPidAlive(peer.pid!)).toBe(true);
      writeMarker(dir, "seed", peer.pid!);
      const peerMarker = readMarker(dir)!;
      expect(isLivePeer(peerMarker)).toBe(true);
      expect(isBuildInFlight(peerMarker)).toBe(true);
    } finally {
      peer.kill();
    }
  });
});

describe("wait loop", () => {
  it("returns when the marker is removed", async () => {
    writeMarker(dir, "build"); // this process's pid: never adopted as dead
    const waiting = waitForBuild(dir, { timeoutMs: 30_000, pollMs: 20 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    clearMarker(dir);
    await expect(waiting).resolves.toBeUndefined();
  });

  it("clears and returns on a dead peer's marker", async () => {
    const pid = await deadPid();
    writeMarker(dir, "build", pid);
    await waitForBuild(dir, { timeoutMs: 30_000, pollMs: 20 });
    expect(readMarker(dir)).toBeUndefined();
  });

  it("fails on timeout with a short injected timeout", async () => {
    writeMarker(dir, "build");
    const texts: string[] = [];
    await expect(
      waitForBuild(dir, {
        timeoutMs: 30,
        pollMs: 10,
        onStatus: (t) => texts.push(t),
      }),
    ).rejects.toBeInstanceOf(BuildWaitTimeout);
    // the timeout did not clear a live build's marker
    expect(readMarker(dir)).toBeDefined();
    expect(texts[0]).toBe(
      `codegraph: waiting for the index build at ${dir} (pid ${process.pid})`,
    );
  });
});
