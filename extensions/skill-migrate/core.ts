/**
 * skill-migrate core: the deterministic migration engine (ADR 0032).
 *
 * This module is the only part of the extension that touches the filesystem.
 * It owns the Migration changelog (read, validate, atomic append), the
 * runner that applies the migration registry in strict order, and the
 * status view. The CLI (cli.ts) and the pi command (index.ts) are thin
 * wrappers over `status` and `migrateToLatest`.
 *
 * Changelog contract: `.pi/skill-migrate_changelog.json` in the target repo,
 * one object holding an append-only `migrations` array. Each record carries
 * the target version, the migration name, the extension identity, and the
 * UTC date time (ISO-8601). There is no top-level version field: the current
 * version is the last record's version, or void when the file is absent.
 *
 * No rollback: a failed migration throws, appends nothing, and points the
 * operator at git restore plus a re-run. Precondition checks make the
 * re-run safe.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const CHANGELOG_RELATIVE_PATH = ".pi/skill-migrate_changelog.json";

export interface MigrationRecord {
  /** The version reached by this migration (1-based, contiguous). */
  version: number;
  /** The migration's name. */
  migration: string;
  /** The identity of the pi-extensions checkout that applied the step. */
  identity: string;
  /** UTC date time, ISO-8601. */
  dateTime: string;
}

export interface Changelog {
  migrations: MigrationRecord[];
}

/** Thrown when a migration refuses to run or fails; the message is operator-facing. */
export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationError";
  }
}

/** Context handed to every migration step. */
export interface MigrationContext {
  /**
   * Absolute directory paths the reference rewrite must never touch. The
   * CLI and command pass the skill-migrate tool's own source and test trees
   * inside the target repo: the old file names appear there as migration
   * data, and rewriting a copy of the tool would break it.
   */
  excludedPaths?: string[];
}

export interface Migration {
  version: number;
  name: string;
  /** Return the list of problems; empty means the step may run. */
  preconditions(repoRoot: string): string[];
  /** Apply the step. May partially change the tree before failing. */
  apply(repoRoot: string, ctx: MigrationContext): void;
  /** Return the list of problems after a successful apply; empty means done. */
  postconditions(repoRoot: string): string[];
}

export interface RepoStatus {
  repoRoot: string;
  currentVersion: number | "void";
  records: MigrationRecord[];
  latestVersion: number;
  upToDate: boolean;
}

export interface MigrateOptions {
  /** The extension identity recorded in every appended record. */
  identity: string;
  /** Clock; injectable so tests get a deterministic date time. */
  now?: () => Date;
  /** Passed through to every migration step. */
  ctx?: MigrationContext;
}

export interface MigrateResult {
  repoRoot: string;
  /** The version before the run (0 means void). */
  fromVersion: number;
  currentVersion: number;
  /** The records appended by this run, in order. */
  applied: MigrationRecord[];
}

const RECORD_FIELDS: { field: keyof MigrationRecord; type: "number" | "string" }[] = [
  { field: "version", type: "number" },
  { field: "migration", type: "string" },
  { field: "identity", type: "string" },
  { field: "dateTime", type: "string" },
];

export function changelogPath(repoRoot: string): string {
  return join(repoRoot, CHANGELOG_RELATIVE_PATH);
}

function isRecord(value: unknown): value is MigrationRecord {
  if (typeof value !== "object" || value === null) return false;
  for (const { field, type } of RECORD_FIELDS) {
    const v = (value as Record<string, unknown>)[field as string];
    if (type === "number") {
      if (typeof v !== "number" || !Number.isInteger(v)) return false;
    } else if (typeof v !== "string" || v.length === 0) {
      return false;
    }
  }
  return true;
}

/**
 * Read and validate the changelog. Returns null when the file is absent
 * (the repo is at void). Throws MigrationError on any malformed content.
 */
export function readChangelog(repoRoot: string): Changelog | null {
  const path = changelogPath(repoRoot);
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new MigrationError(`Malformed migration changelog at ${CHANGELOG_RELATIVE_PATH}: not valid JSON (${(error as Error).message}).`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new MigrationError(`Malformed migration changelog at ${CHANGELOG_RELATIVE_PATH}: expected an object holding a migrations array.`);
  }
  const migrations = (parsed as { migrations?: unknown }).migrations;
  if (!Array.isArray(migrations)) {
    throw new MigrationError(`Malformed migration changelog at ${CHANGELOG_RELATIVE_PATH}: missing the migrations array.`);
  }
  for (let i = 0; i < migrations.length; i++) {
    const record = migrations[i];
    if (!isRecord(record)) {
      throw new MigrationError(
        `Malformed migration changelog at ${CHANGELOG_RELATIVE_PATH}: record ${i + 1} must be an object with an integer version, and non-empty string migration, identity, and dateTime.`,
      );
    }
    if (record.version !== i + 1) {
      throw new MigrationError(
        `Malformed migration changelog at ${CHANGELOG_RELATIVE_PATH}: versions must be contiguous from 1; record ${i + 1} is version ${record.version}.`,
      );
    }
  }
  return { migrations };
}

/** The repo's current version: the last record's version, or void. */
export function currentVersion(repoRoot: string): number | "void" {
  const changelog = readChangelog(repoRoot);
  if (!changelog || changelog.migrations.length === 0) return "void";
  return changelog.migrations[changelog.migrations.length - 1].version;
}

/** The latest version the registry can reach. */
export function latestVersion(registry: readonly Migration[]): number {
  let latest = 0;
  for (const migration of registry) latest = Math.max(latest, migration.version);
  return latest;
}

/**
 * Append one record. The file is written atomically (temp file plus
 * rename); existing records are never rewritten.
 */
export function appendRecord(repoRoot: string, record: MigrationRecord): void {
  const changelog = readChangelog(repoRoot) ?? { migrations: [] };
  changelog.migrations.push(record);
  const path = changelogPath(repoRoot);
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tempPath, JSON.stringify(changelog, null, 2) + "\n");
    renameSync(tempPath, path);
  } catch (error) {
    try {
      if (existsSync(tempPath)) writeFileSync(tempPath, "");
    } catch {
      /* best effort cleanup */
    }
    throw new MigrationError(`Could not write the migration changelog at ${CHANGELOG_RELATIVE_PATH}: ${(error as Error).message}.`);
  }
}

/** Report where a repo stands without changing anything. */
export function status(repoRoot: string, registry: readonly Migration[]): RepoStatus {
  const resolvedRoot = resolve(repoRoot);
  if (!existsSync(resolvedRoot) || !statSync(resolvedRoot).isDirectory()) {
    throw new MigrationError(`Target repo not found: ${resolvedRoot}`);
  }
  const records = readChangelog(resolvedRoot)?.migrations ?? [];
  const current: number | "void" = records.length === 0 ? "void" : records[records.length - 1].version;
  const latest = latestVersion(registry);
  return {
    repoRoot: resolvedRoot,
    currentVersion: current,
    records,
    latestVersion: latest,
    upToDate: current === latest,
  };
}

/**
 * Apply every migration above the repo's current version, in strict order.
 * Preconditions run before each step, postconditions after; a record is
 * appended only after both pass. On any failure nothing of that step is
 * recorded and the error tells the operator to restore with git and re-run.
 */
export function migrateToLatest(repoRoot: string, registry: readonly Migration[], options: MigrateOptions): MigrateResult {
  const resolvedRoot = resolve(repoRoot);
  if (!existsSync(resolvedRoot) || !statSync(resolvedRoot).isDirectory()) {
    throw new MigrationError(`Target repo not found: ${resolvedRoot}`);
  }
  const sorted = [...registry].sort((a, b) => a.version - b.version);
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].version !== i + 1) {
      throw new MigrationError(`Migration registry is malformed: versions must be contiguous from 1 (gap at version ${i + 1}).`);
    }
  }
  const from = currentVersion(resolvedRoot) === "void" ? 0 : (currentVersion(resolvedRoot) as number);
  const applied: MigrationRecord[] = [];
  const context: MigrationContext = options.ctx ?? {};
  const now = options.now ?? (() => new Date());
  for (const migration of sorted) {
    if (migration.version <= from) continue;
    const failed = (phase: string, problems: string[], appliedChanges: boolean): never => {
      const restore = appliedChanges
        ? `Restore the repo to its pre-migration state (for example \`git restore .\`), then re-run. No record was appended for this step.`
        : `This step changed nothing. No record was appended for this step.`;
      const list = problems.map((p) => `  - ${p}`).join("\n");
      throw new MigrationError(`Migration ${migration.version} (${migration.name}) ${phase} failed for ${resolvedRoot}:\n${list}\n${restore}`);
    };
    const pre = migration.preconditions(resolvedRoot);
    if (pre.length > 0) failed("precondition", pre, false);
    try {
      migration.apply(resolvedRoot, context);
    } catch (error) {
      if (error instanceof MigrationError) throw error;
      throw new MigrationError(
        `Migration ${migration.version} (${migration.name}) failed while applying for ${resolvedRoot}: ${(error as Error).message}\nRestore the repo to its pre-migration state (for example \`git restore .\`), then re-run. No record was appended.`,
      );
    }
    const post = migration.postconditions(resolvedRoot);
    if (post.length > 0) failed("postcondition", post, true);
    const record: MigrationRecord = {
      version: migration.version,
      migration: migration.name,
      identity: options.identity,
      dateTime: now().toISOString(),
    };
    appendRecord(resolvedRoot, record);
    applied.push(record);
  }
  return { repoRoot: resolvedRoot, fromVersion: from, currentVersion: latestVersion(sorted), applied };
}
