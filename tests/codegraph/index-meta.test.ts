/**
 * Index-meta module: the per-index advisory meta record.
 *
 * Fast unit tests: no index build, no library. A plain temporary directory
 * stands in for the index directory (the module takes the directory, not
 * the root - the layout belongs to the Index adapter, spec 0003).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  clearSeedRecord,
  META_NAME,
  readMeta,
  recordReconcile,
  recordSeed,
  writeMeta,
} from "../../extensions/codegraph/index-meta";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-meta-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

it("a missing file reads as an empty record", () => {
  expect(readMeta(dir)).toEqual({});
});

it("a malformed file reads as an empty record", () => {
  fs.writeFileSync(path.join(dir, META_NAME), "not json");
  expect(readMeta(dir)).toEqual({});
});

it("round-trips a record under the documented name", () => {
  const record = {
    seedSource: "/sibling",
    seededAt: 111,
    lastReconcileAt: 222,
    lastReconcileChanged: 3,
  };
  writeMeta(dir, record);
  expect(readMeta(dir)).toEqual(record);
  expect(fs.existsSync(path.join(dir, META_NAME))).toBe(true);
});

it("an advisory write failure does not throw", () => {
  // A file where the index directory must be: the write must fail, and
  // the failure must be swallowed.
  const blocker = path.join(dir, "blocker");
  fs.writeFileSync(blocker, "not a directory");
  const blocked = path.join(blocker, "proj");
  expect(() => writeMeta(blocked, { seedSource: "/s" })).not.toThrow();
  expect(readMeta(blocked)).toEqual({});
});

it("records a seed and removes the seed record", () => {
  recordSeed(dir, "/sibling");
  const meta = readMeta(dir);
  expect(meta.seedSource).toBe("/sibling");
  expect(typeof meta.seededAt).toBe("number");
  clearSeedRecord(dir);
  expect(readMeta(dir)).toEqual({});
});

it("records a reconcile and returns the stored timestamp", () => {
  recordSeed(dir, "/sibling");
  const at = recordReconcile(dir, 5);
  const meta = readMeta(dir);
  expect(meta.lastReconcileAt).toBe(at);
  expect(meta.lastReconcileChanged).toBe(5);
  // the seed record survives a reconcile
  expect(meta.seedSource).toBe("/sibling");
});
