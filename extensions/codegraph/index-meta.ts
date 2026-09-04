/**
 * The per-index meta record.
 *
 * `<codeGraphDir>/pi-codegraph-meta.json` records where an index was
 * seeded from and when its last reconcile ran. The record is advisory:
 * writes happen after the fact, and a write failure is swallowed so a meta
 * problem never fails a query.
 *
 * The module takes the index directory as a parameter, not the root: the
 * directory layout belongs to the codegraph library and is known only to
 * the Index adapter (spec 0003).
 */
import fs from "node:fs";
import path from "node:path";

export const META_NAME = "pi-codegraph-meta.json";

export interface Meta {
  seedSource?: string;
  seededAt?: number;
  lastReconcileAt?: number;
  lastReconcileChanged?: number;
}

function metaPath(dir: string): string {
  return path.join(dir, META_NAME);
}

/** A missing or unreadable file reads as an empty record. */
export function readMeta(dir: string): Meta {
  try {
    return (JSON.parse(fs.readFileSync(metaPath(dir), "utf-8")) as Meta) ?? {};
  } catch {
    return {};
  }
}

/** Advisory: failures are swallowed, never failing a query. */
export function writeMeta(dir: string, meta: Meta): void {
  try {
    fs.writeFileSync(metaPath(dir), JSON.stringify(meta));
  } catch {
    // metadata is advisory - never fail a query over it
  }
}

/** Record that the index was seeded from `source`. */
export function recordSeed(dir: string, source: string): void {
  const meta = readMeta(dir);
  meta.seedSource = source;
  meta.seededAt = Date.now();
  writeMeta(dir, meta);
}

/**
 * Record a completed reconcile. Returns the timestamp it stored, so the
 * caller can hold the same value in memory.
 */
export function recordReconcile(dir: string, changed: number): number {
  const meta = readMeta(dir);
  const at = Date.now();
  meta.lastReconcileAt = at;
  meta.lastReconcileChanged = changed;
  writeMeta(dir, meta);
  return at;
}

/** Remove the seed record (a full rebuild replaces a seeded index). */
export function clearSeedRecord(dir: string): void {
  const meta = readMeta(dir);
  delete meta.seedSource;
  delete meta.seededAt;
  writeMeta(dir, meta);
}
