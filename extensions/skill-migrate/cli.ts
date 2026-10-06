/**
 * skill-migrate CLI: `status` and `migrate` for humans (ADR 0032).
 *
 *   node extensions/skill-migrate/cli.mjs status  [repo-path]
 *   node extensions/skill-migrate/cli.mjs migrate [repo-path]
 *
 * The repo path defaults to the current directory. `migrate` always runs
 * to the latest known migration; a failed migration exits non-zero,
 * appends nothing, and points the operator at git restore plus a re-run.
 * The pi slash command (index.ts) runs the same two verbs on the session's
 * project root.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MigrationError, migrateToLatest, status, type MigrateResult, type RepoStatus } from "./core.ts";
import { MIGRATIONS } from "./migrations.ts";
import { resolveIdentity } from "./identity.ts";

const extensionDir = dirname(fileURLToPath(import.meta.url));
// The extension lives at <checkout>/extensions/skill-migrate, so the
// checkout root is two levels up.
const checkoutRoot = resolve(join(extensionDir, "..", ".."));

export interface CliOutput {
  out: (line: string) => void;
  err: (line: string) => void;
}

const HELP = `skill-migrate: deterministic repo-structure migrations with a committed changelog (ADR 0032)

usage:
  skill-migrate status  [repo-path]   report the repo's current structure version
  skill-migrate migrate [repo-path]   apply every pending migration, in order

repo-path defaults to the current directory.
--identity <id> overrides the recorded extension identity (tests only).`;

function renderStatus(result: RepoStatus): string {
  const lines: string[] = [];
  lines.push(`Target repo: ${result.repoRoot}`);
  lines.push(`Current version: ${result.currentVersion === "void" ? "void" : String(result.currentVersion)}`);
  lines.push(`Latest known version: ${result.latestVersion}`);
  lines.push(result.upToDate ? "Up to date." : "Not up to date.");
  if (result.records.length > 0) {
    lines.push("Records:");
    for (const record of result.records) {
      lines.push(`  ${String(record.version).padStart(2)}  ${record.migration.padEnd(20)} ${record.identity}  ${record.dateTime}`);
    }
  }
  return lines.join("\n");
}

function renderMigrate(result: MigrateResult): string {
  if (result.applied.length === 0) {
    return `Target repo: ${result.repoRoot}\nCurrent version: ${String(result.currentVersion)}\nUp to date; nothing to do.`;
  }
  const lines: string[] = [];
  lines.push(`Target repo: ${result.repoRoot}`);
  lines.push(`Migrated ${result.fromVersion === 0 ? "void" : String(result.fromVersion)} to ${String(result.currentVersion)}:`);
  for (const record of result.applied) {
    lines.push(`  ${String(record.version).padStart(2)}  ${record.migration}`);
  }
  lines.push("Commit the changelog and every changed file so the new structure version travels with the repo.");
  return lines.join("\n");
}

/**
 * Run one CLI invocation. Returns the exit code.
 */
export async function main(argv: string[], output: CliOutput = { out: console.log, err: console.error }): Promise<number> {
  let identityOverride: string | undefined;
  const args: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--identity") {
      identityOverride = argv[++i];
      if (identityOverride === undefined) {
        output.err("--identity needs a value.");
        return 2;
      }
    } else {
      args.push(argv[i]);
    }
  }
  const [command, ...rest] = args;
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    (command === undefined ? output.err : output.out)(HELP);
    return command === undefined ? 2 : 0;
  }
  if (command !== "status" && command !== "migrate") {
    output.err(`Unknown command "${command}".\n\n${HELP}`);
    return 2;
  }
  if (rest.length > 1) {
    output.err(`Expected at most one repo path, got ${rest.length}.`);
    return 2;
  }
  const repoRoot = rest[0] ?? process.cwd();
  try {
    if (command === "status") {
      output.out(renderStatus(status(repoRoot, MIGRATIONS)));
    } else {
      const identity = identityOverride ?? resolveIdentity(checkoutRoot);
      const resolvedRoot = resolve(repoRoot);
      // The old file names appear as migration data inside the skill-migrate
      // tool's own source and test trees; a copy of the tool inside the
      // target repo must not be rewritten into a broken tool.
      const excludedPaths = [join(resolvedRoot, "extensions", "skill-migrate"), join(resolvedRoot, "tests", "skill-migrate")];
      output.out(renderMigrate(migrateToLatest(resolvedRoot, MIGRATIONS, { identity, ctx: { excludedPaths } })));
    }
    return 0;
  } catch (error) {
    if (error instanceof MigrationError) {
      output.err(error.message);
      return 1;
    }
    throw error;
  }
}
