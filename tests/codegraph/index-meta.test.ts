/**
 * Index-meta module: the per-index advisory meta record.
 *
 * Fast unit tests: no index build. A plain temporary directory stands in
 * for a project root.
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
import { getCodeGraphDir } from "../../extensions/codegraph/codegraph";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-meta-"));
  // The meta record only exists once the index directory does; create it
  // like the codegraph init would.
  fs.mkdirSync(getCodeGraphDir(root), { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

it("a missing file reads as an empty record", () => {
  expect(readMeta(root)).toEqual({});
});

it("a malformed file reads as an empty record", () => {
  fs.mkdirSync(getCodeGraphDir(root), { recursive: true });
  fs.writeFileSync(path.join(getCodeGraphDir(root), META_NAME), "not json");
  expect(readMeta(root)).toEqual({});
});

it("round-trips a record under the documented name", () => {
  const record = {
    seedSource: "/sibling",
    seededAt: 111,
    lastReconcileAt: 222,
    lastReconcileChanged: 3,
  };
  writeMeta(root, record);
  expect(readMeta(root)).toEqual(record);
  expect(fs.existsSync(path.join(getCodeGraphDir(root), META_NAME))).toBe(
    true,
  );
});

it("an advisory write failure does not throw", () => {
  // A file where the index directory must be: the write must fail, and
  // the failure must be swallowed.
  const blocker = path.join(root, "blocker");
  fs.writeFileSync(blocker, "not a directory");
  const blocked = path.join(blocker, "proj");
  expect(() => writeMeta(blocked, { seedSource: "/s" })).not.toThrow();
  expect(readMeta(blocked)).toEqual({});
});

it("records a seed and removes the seed record", () => {
  recordSeed(root, "/sibling");
  const meta = readMeta(root);
  expect(meta.seedSource).toBe("/sibling");
  expect(typeof meta.seededAt).toBe("number");
  clearSeedRecord(root);
  expect(readMeta(root)).toEqual({});
});

it("records a reconcile and returns the stored timestamp", () => {
  recordSeed(root, "/sibling");
  const at = recordReconcile(root, 5);
  const meta = readMeta(root);
  expect(meta.lastReconcileAt).toBe(at);
  expect(meta.lastReconcileChanged).toBe(5);
  // the seed record survives a reconcile
  expect(meta.seedSource).toBe("/sibling");
});
