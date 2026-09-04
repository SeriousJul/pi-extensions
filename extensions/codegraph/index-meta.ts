/**
 * The per-index meta record.
 *
 * `<root>/.codegraph/pi-codegraph-meta.json` records where an index was
 * seeded from and when its last reconcile ran. The record is advisory:
 * writes happen after the fact, and a write failure is swallowed so a meta
 * problem never fails a query.
 */
import fs from "node:fs";
import path from "node:path";
import { getCodeGraphDir } from "./runtime";

export const META_NAME = "pi-codegraph-meta.json";

export interface Meta {
  seedSource?: string;
  seededAt?: number;
  lastReconcileAt?: number;
  lastReconcileChanged?: number;
}

function metaPath(root: string): string {
  return path.join(getCodeGraphDir(root), META_NAME);
}

/** A missing or unreadable file reads as an empty record. */
export function readMeta(root: string): Meta {
  try {
    return (JSON.parse(fs.readFileSync(metaPath(root), "utf-8")) as Meta) ?? {};
  } catch {
    return {};
  }
}

/** Advisory: failures are swallowed, never failing a query. */
export function writeMeta(root: string, meta: Meta): void {
  try {
    fs.writeFileSync(metaPath(root), JSON.stringify(meta));
  } catch {
    // metadata is advisory - never fail a query over it
  }
}

/** Record that the index was seeded from `source`. */
export function recordSeed(root: string, source: string): void {
  const meta = readMeta(root);
  meta.seedSource = source;
  meta.seededAt = Date.now();
  writeMeta(root, meta);
}

/**
 * Record a completed reconcile. Returns the timestamp it stored, so the
 * caller can hold the same value in memory.
 */
export function recordReconcile(root: string, changed: number): number {
  const meta = readMeta(root);
  const at = Date.now();
  meta.lastReconcileAt = at;
  meta.lastReconcileChanged = changed;
  writeMeta(root, meta);
  return at;
}

/** Remove the seed record (a full rebuild replaces a seeded index). */
export function clearSeedRecord(root: string): void {
  const meta = readMeta(root);
  delete meta.seedSource;
  delete meta.seededAt;
  writeMeta(root, meta);
}
