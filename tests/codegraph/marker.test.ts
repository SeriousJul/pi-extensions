/**
 * Marker module: the cross-process build marker contract.
 *
 * Fast unit tests: no index build. A plain temporary directory stands in
 * for a project root.
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
import { getCodeGraphDir } from "../../extensions/codegraph/runtime";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-marker-"));
  // The marker is only ever written once the index directory exists (the
  // codegraph init or the lock path creates it); the module does not.
  fs.mkdirSync(getCodeGraphDir(root), { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** A pid whose process has exited: the marker it owned reads as dead. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  return child.pid!;
}

describe("marker file", () => {
  it("reads as absent when the file is missing", () => {
    expect(readMarker(root)).toBeUndefined();
  });

  it("round-trips write, read, and clear", () => {
    writeMarker(root, "seed");
    const marker = readMarker(root);
    expect(marker?.pid).toBe(process.pid);
    expect(marker?.startedAt).toBeTypeOf("number");
    expect(marker?.mode).toBe("seed");
    clearMarker(root);
    expect(readMarker(root)).toBeUndefined();
  });

  it("writes under the documented name in the index directory", () => {
    writeMarker(root, "build");
    expect(markerPath(root)).toBe(
      path.join(getCodeGraphDir(root), MARKER_NAME),
    );
    expect(fs.existsSync(markerPath(root))).toBe(true);
  });

  it("reads a malformed file as absent", () => {
    fs.mkdirSync(getCodeGraphDir(root), { recursive: true });
    fs.writeFileSync(markerPath(root), "not json");
    expect(readMarker(root)).toBeUndefined();
    fs.writeFileSync(markerPath(root), JSON.stringify({ startedAt: 1 }));
    expect(readMarker(root)).toBeUndefined();
  });
});

describe("pid liveness", () => {
  it("reads a dead pid as dead", async () => {
    const pid = await deadPid();
    expect(isPidAlive(pid)).toBe(false);
    writeMarker(root, "build", pid);
    const marker = readMarker(root)!;
    expect(isLivePeer(marker)).toBe(false);
    expect(isBuildInFlight(marker)).toBe(false);
  });

  it("reads this process and a spawned peer as live", () => {
    expect(isPidAlive(process.pid)).toBe(true);
    writeMarker(root, "build");
    const own = readMarker(root)!;
    expect(isBuildInFlight(own)).toBe(true);
    expect(isLivePeer(own)).toBe(false); // its own marker is not a peer

    const peer = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      expect(isPidAlive(peer.pid!)).toBe(true);
      writeMarker(root, "seed", peer.pid!);
      const peerMarker = readMarker(root)!;
      expect(isLivePeer(peerMarker)).toBe(true);
      expect(isBuildInFlight(peerMarker)).toBe(true);
    } finally {
      peer.kill();
    }
  });
});

describe("wait loop", () => {
  it("returns when the marker is removed", async () => {
    writeMarker(root, "build"); // this process's pid: never adopted as dead
    const waiting = waitForBuild(root, { timeoutMs: 30_000, pollMs: 20 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    clearMarker(root);
    await expect(waiting).resolves.toBeUndefined();
  });

  it("clears and returns on a dead peer's marker", async () => {
    const pid = await deadPid();
    writeMarker(root, "build", pid);
    await waitForBuild(root, { timeoutMs: 30_000, pollMs: 20 });
    expect(readMarker(root)).toBeUndefined();
  });

  it("fails on timeout with a short injected timeout", async () => {
    writeMarker(root, "build");
    const texts: string[] = [];
    await expect(
      waitForBuild(root, {
        timeoutMs: 30,
        pollMs: 10,
        onStatus: (t) => texts.push(t),
      }),
    ).rejects.toBeInstanceOf(BuildWaitTimeout);
    // the timeout did not clear a live build's marker
    expect(readMarker(root)).toBeDefined();
    expect(texts[0]).toBe(
      `codegraph: waiting for the index build at ${root} (pid ${process.pid})`,
    );
  });
});
