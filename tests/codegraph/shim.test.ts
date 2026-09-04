/**
 * sqlite-shim compatibility tests.
 *
 * The shim must present the node:sqlite surface codegraph uses, on whatever
 * runtime vitest runs in: the real node:sqlite (Node) or the bun:sqlite
 * emulation (bun). The most important check is bare-key named parameters,
 * because that is the one convention difference between the two engines.
 *
 * Run the vitest suite under `bun test`/vitest-in-bun as well to exercise
 * the bun path end to end (see shim-bun.test.cts for a bun-only full
 * codegraph round trip).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import shim from "../../extensions/codegraph/sqlite-shim.cjs";

let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-shim-"));
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("shim surface", () => {
  it("exposes DatabaseSync, backupFile, and a known backend", () => {
    expect(typeof shim.DatabaseSync).toBe("function");
    expect(typeof shim.backupFile).toBe("function");
    // backup is the node:sqlite online backup (Node 22.16+/23.8+, bun) or
    // the bun serialize copy; it is undefined on Node 22.5-22.15, where
    // backupFile is the seed copy path instead.
    expect(["function", "undefined"]).toContain(typeof shim.backup);
    expect(["node:sqlite", "bun:sqlite"]).toContain(shim.backend);
  });

  it("round-trips rows through bare-key named parameters", () => {
    const file = path.join(dir, "rt.db");
    const db = new shim.DatabaseSync(file);
    expect(db.isOpen).toBe(true);
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");
    const run = db
      .prepare("INSERT INTO t (id, name) VALUES (@id, @name)")
      .run({ id: 7, name: "seven" });
    expect(run.changes).toBe(1);
    expect(Number(run.lastInsertRowid)).toBe(7);
    const got = db
      .prepare("SELECT name FROM t WHERE id = @id")
      .get({ id: 7 });
    expect(got).toMatchObject({ name: "seven" });
    const all = db.prepare("SELECT * FROM t ORDER BY id").all();
    expect(all).toHaveLength(1);
    db.close();
    expect(db.isOpen).toBe(false);
    // The bun emulation makes close() idempotent (the adapter's own guard
    // is `if (db?.isOpen) db.close()`; real node:sqlite throws on a second
    // close, so idempotency is only asserted for the emulation).
    if (shim.backend === "bun:sqlite") {
      db.close();
    }
  });

  it("supports positional parameters", () => {
    const file = path.join(dir, "pos.db");
    const db = new shim.DatabaseSync(file);
    db.exec("CREATE TABLE t (v TEXT)");
    db.prepare("INSERT INTO t VALUES (?)").run("a");
    db.prepare("INSERT INTO t VALUES (?)").run("b");
    expect(db.prepare("SELECT v FROM t ORDER BY v").all()).toEqual([
      { v: "a" },
      { v: "b" },
    ]);
    db.close();
  });

  it("streams rows through async iteration", async () => {
    const file = path.join(dir, "iter.db");
    const db = new shim.DatabaseSync(file);
    db.exec("CREATE TABLE t (id INTEGER)");
    for (let i = 0; i < 5; i++) {
      db.prepare("INSERT INTO t VALUES (@id)").run({ id: i });
    }
    const rows: unknown[] = [];
    for await (const row of db.prepare("SELECT id FROM t ORDER BY id").iterate()) {
      rows.push(row);
    }
    expect(rows).toHaveLength(5);
    db.close();
  });

  it("copies a database with backup() when the backup API exists", async () => {
    const srcFile = path.join(dir, "src.db");
    const dstFile = path.join(dir, "dst.db");
    const src = new shim.DatabaseSync(srcFile);
    src.exec("CREATE TABLE t (v TEXT)");
    src.prepare("INSERT INTO t VALUES (@v)").run({ v: "copied" });
    if (shim.backup) {
      await shim.backup(src, dstFile);
      const dst = new shim.DatabaseSync(dstFile, { readOnly: true });
      expect(dst.prepare("SELECT v FROM t").all()).toEqual([{ v: "copied" }]);
      dst.close();
    }
    src.close();
  });

  it("copies a WAL database with backupFile() (checkpoint + file copy)", async () => {
    // The Node 22.5-22.15 seed path: the row must land in the WAL (no
    // checkpoint between the insert and the copy), so a bare file copy of
    // the main database would be stale. Only the checkpoint + copy path
    // yields the row in the destination.
    const srcFile = path.join(dir, "cf-src.db");
    const dstFile = path.join(dir, "cf-dst.db");
    const src = new shim.DatabaseSync(srcFile);
    src.exec("PRAGMA journal_mode = WAL");
    src.exec("CREATE TABLE t (v TEXT)");
    src.prepare("INSERT INTO t VALUES (@v)").run({ v: "checkpointed" });
    await shim.backupFile(srcFile, dstFile);
    src.close();
    const dst = new shim.DatabaseSync(dstFile, { readOnly: true });
    expect(dst.prepare("SELECT v FROM t").all()).toEqual([
      { v: "checkpointed" },
    ]);
    dst.close();
  });

  it("reports read-only open of a missing file as an error", () => {
    expect(() =>
      new shim.DatabaseSync(path.join(dir, "missing.db"), {
        readOnly: true,
      }),
    ).toThrow();
  });
});

describe("named parameter translation", () => {
  it("finds named parameters and skips literals and comments", () => {
    expect(
      shim.findNamedParams(
        "UPDATE t SET a = @a, b = :b, c = $c WHERE d = @a -- @not\n" +
          "'@in-literal' /* @in-comment */",
      ),
    ).toEqual(["@a", ":b", "$c"]);
    expect(
      shim.findNamedParams("SELECT ':' FROM t"),
    ).toEqual([]);
  });

  it("maps bare-key objects to prefixed keys", () => {
    expect(
      shim.mapNamedParams("SELECT * FROM t WHERE id = @id", [{ id: 3 }]),
    ).toEqual([{ "@id": 3 }]);
    // mix of prefixes: first occurrence wins per bare key
    expect(
      shim.mapNamedParams("SELECT @x, :x FROM t", [{ x: 1 }]),
    ).toEqual([{ "@x": 1 }]);
    // positional args pass through
    expect(shim.mapNamedParams("SELECT ?", [1, 2])).toEqual([1, 2]);
    // arrays pass through
    expect(
      shim.mapNamedParams("SELECT ? IN (@all)", [[1, 2]]),
    ).toEqual([[1, 2]]);
    // empty object passes through
    expect(
      shim.mapNamedParams("SELECT @id FROM t", [{}]),
    ).toEqual([{}]);
  });
});
