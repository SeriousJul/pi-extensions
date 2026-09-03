/**
 * SQLite runtime shim for codegraph.
 *
 * codegraph 1.6.0 opens its databases with Node's built-in `node:sqlite`.
 * That module exists on Node >= 22.5, but NOT on the Bun runtime that pi
 * embeds (bun < 1.4 has no `node:sqlite`; it has `bun:sqlite` instead).
 * Without this shim, codegraph cannot open a database inside pi at all.
 *
 * This module exports the same surface on both runtimes:
 *   - `DatabaseSync` - the database handle class
 *   - `backup(source, destination)` - async DB copy (undefined on Node
 *     22.5-22.15, which lack the node:sqlite backup API; use `backupFile`)
 *   - `backupFile(sourcePath, destinationPath)` - consistent DB copy via
 *     WAL checkpoint + file copy (the backup-API-free fallback)
 *   - `backend` - "node:sqlite" or "bun:sqlite" (which one is active)
 *   - `findNamedParams(sql)` / `mapNamedParams(sql, params)` - for tests
 *
 * On a runtime with `node:sqlite` (real Node), the real module's exports
 * are used verbatim. On a runtime without it (bun), a thin emulation is
 * provided over `bun:sqlite`, which is also real SQLite (WAL, FTS5, named
 * parameters) with a slightly different parameter convention: `bun:sqlite`
 * wants the prefix character in the binding object's keys (`{"@id": 1}`)
 * while `node:sqlite` wants bare keys (`{ id: 1 }`). `mapNamedParams`
 * translates between the two.
 *
 * Wiring:
 *   - codegraph's internal `require('node:sqlite')` is rewritten to this
 *     file by scripts/patch-codegraph.mjs (postinstall).
 *   - This extension imports this file directly for the seed copy
 *     (see seed.ts).
 *
 * Set CODEGRAPH_PI_SQLITE_SHIM=bun to force the bun:sqlite path (tests).
 *
 * This file is deliberately pure CommonJS JavaScript (no TypeScript
 * syntax) so that every loader pi can run it through (bun, vitest, node)
 * parses it without a language flag. Types live in sqlite-shim.d.cts.
 */
"use strict";

const fs = require("node:fs");

/** Load `bun:sqlite`. The non-literal specifier keeps static tooling from
 * trying to resolve a module that only exists in the bun runtime. */
function loadBunSqlite() {
  let mod;
  try {
    mod = require("bun:" + "sqlite");
  } catch (err) {
    throw new Error(
      "codegraph sqlite shim: this runtime has neither node:sqlite nor " +
        "bun:sqlite. Open a database only on Node >= 22.5 or bun. " +
        `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return mod.Database;
}

function loadNodeSqlite() {
  if (process.env.CODEGRAPH_PI_SQLITE_SHIM === "bun") return null;
  try {
    return require("node:sqlite");
  } catch {
    return null;
  }
}

/**
 * Find SQLite named parameters (`@name`, `:name`, `$name`) in a SQL string,
 * in order of first appearance. String literals, quoted identifiers and
 * comments are skipped so parameter-looking text inside them does not count.
 */
function findNamedParams(sql) {
  const out = [];
  const seen = new Set();
  const n = sql.length;
  let i = 0;
  const skipQuoted = (start, quote) => {
    let j = start;
    while (j < n) {
      if (sql[j] === quote) {
        if (sql[j + 1] === quote) {
          j += 2; // doubled quote escape
          continue;
        }
        return j + 1;
      }
      j++;
    }
    return j;
  };
  while (i < n) {
    const c = sql[i];
    if (c === "'" || c === '"' || c === "`") {
      i = skipQuoted(i + 1, c);
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? n : nl + 1;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (c === "@" || c === "$" || c === ":") {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(i + 1));
      if (m) {
        const full = c + m[0];
        if (!seen.has(full)) {
          seen.add(full);
          out.push(full);
        }
        i += m[0].length;
        continue;
      }
    }
    i++;
  }
  return out;
}

/**
 * Translate node:sqlite-style parameters to bun:sqlite-style. node:sqlite
 * binds a single plain object with BARE keys (`{ id: 1 }` for `@id` in the
 * SQL); bun:sqlite wants the prefix in the key (`{ "@id": 1 }`). Positional
 * arguments and arrays pass through unchanged.
 */
function mapNamedParams(sql, params) {
  if (params.length !== 1) return params;
  const obj = params[0];
  if (
    typeof obj !== "object" ||
    obj === null ||
    Array.isArray(obj) ||
    Object.keys(obj).length === 0
  ) {
    return params;
  }
  const named = findNamedParams(sql);
  if (named.length === 0) return params;
  const prefixed = new Map();
  for (const p of named) {
    const bare = p.slice(1);
    if (!prefixed.has(bare)) prefixed.set(bare, p);
  }
  const mapped = {};
  for (const [key, value] of Object.entries(obj)) {
    mapped[prefixed.get(key) ?? key] = value;
  }
  return [mapped];
}

/** node:sqlite-style statement over a bun:sqlite statement. */
class BunStatement {
  constructor(sql, stmt, assertOpen) {
    this._sql = sql;
    this._stmt = stmt;
    this._assertOpen = assertOpen;
  }

  run(...params) {
    this._assertOpen();
    const r = this._stmt.run(...mapNamedParams(this._sql, params));
    return {
      changes: Number(r?.changes ?? 0),
      lastInsertRowid: Number(r?.lastInsertRowid ?? 0),
    };
  }

  get(...params) {
    this._assertOpen();
    return this._stmt.get(...mapNamedParams(this._sql, params));
  }

  all(...params) {
    this._assertOpen();
    return this._stmt.all(...mapNamedParams(this._sql, params));
  }

  /**
   * node:sqlite's iterate() is a SYNCHRONOUS iterator, and codegraph walks
   * it with `for (const row of stmt.iterate())`. bun:sqlite only has an
   * async iterate(), so materialize the rows with the sync all() and hand
   * back a plain array iterator. Same visible behavior; rows are bounded
   * by the query (codegraph uses iterate for lookups, not bulk dumps).
   */
  iterate(...params) {
    this._assertOpen();
    return this._stmt.all(...mapNamedParams(this._sql, params))[Symbol
      .iterator]();
  }
}

/** node:sqlite-compatible handle over bun:sqlite's Database. */
class BunDatabaseSync {
  constructor(path, opts) {
    const Database = loadBunSqlite();
    this._db = opts?.readOnly
      ? new Database(path, { readonly: true })
      : new Database(path, { create: true });
    this._closed = false;
  }

  get isOpen() {
    return !this._closed;
  }

  prepare(sql) {
    this._assertOpen();
    return new BunStatement(sql, this._db.prepare(sql), () =>
      this._assertOpen(),
    );
  }

  exec(sql) {
    this._assertOpen();
    this._db.exec(sql);
  }

  /** Full consistent image of the database (bun:sqlite only). */
  serialize() {
    this._assertOpen();
    return this._db.serialize();
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    try {
      this._db.close();
    } catch {
      // Already closed; close() must stay idempotent like the adapter's
      // wrapper assumes.
    }
  }

  _assertOpen() {
    if (this._closed) {
      throw new Error("codegraph sqlite shim: database is closed");
    }
  }
}

async function bunBackup(source, destination) {
  fs.writeFileSync(destination, source.serialize());
  return 0;
}

/** Synchronous sleep (checkpoint retries). */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Consistent database copy WITHOUT the backup API (Node 22.5-22.15 have
 * node:sqlite but no `backup`). Checkpoint the source's WAL into its main
 * file, then copy the main file: after a successful TRUNCATE checkpoint the
 * main file is a self-contained, consistent snapshot. A checkpoint that
 * stays busy (another connection holds a long read transaction) is retried,
 * then fails loudly - copying a non-checkpointed WAL database would lose
 * the WAL's contents.
 */
async function backupFile(sourcePath, destinationPath, DatabaseCtor) {
  const src = new DatabaseCtor(sourcePath);
  try {
    const stmt = src.prepare("PRAGMA wal_checkpoint(TRUNCATE)");
    for (let attempt = 0; ; attempt++) {
      const row = stmt.get();
      if (!row || Number(row.busy) === 0) break;
      if (attempt >= 5) {
        throw new Error(
          "codegraph sqlite shim: could not checkpoint " +
            sourcePath +
            " for the seed copy (database is busy)",
        );
      }
      sleepSync(250 * (attempt + 1));
    }
  } finally {
    src.close();
  }
  fs.copyFileSync(sourcePath, destinationPath);
}

const nodeSqlite = loadNodeSqlite();

if (nodeSqlite && typeof nodeSqlite.DatabaseSync === "function") {
  // Real node:sqlite (Node >= 22.5): use it verbatim. The module-level
  // backup API only exists on Node >= 22.16 / 23.8; on 22.5-22.15 the
  // checkpoint + file copy fallback is exposed as backupFile instead.
  module.exports = {
    DatabaseSync: nodeSqlite.DatabaseSync,
    backup:
      typeof nodeSqlite.backup === "function" ? nodeSqlite.backup : undefined,
    backupFile: (sourcePath, destinationPath) =>
      backupFile(sourcePath, destinationPath, nodeSqlite.DatabaseSync),
    findNamedParams,
    mapNamedParams,
    backend: "node:sqlite",
  };
} else {
  // bun (pi's runtime): emulate node:sqlite over bun:sqlite.
  module.exports = {
    DatabaseSync: BunDatabaseSync,
    backup: bunBackup,
    backupFile: (sourcePath, destinationPath) =>
      backupFile(sourcePath, destinationPath, BunDatabaseSync),
    findNamedParams,
    mapNamedParams,
    backend: "bun:sqlite",
  };
}
