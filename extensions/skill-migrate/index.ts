/**
 * skill-migrate: pi command entry (ADR 0032).
 *
 * Registers exactly one slash command and nothing else: no tools, no prompt
 * text, so the extension costs the session nothing while idle. The command
 * runs the same two verbs as the CLI on the session's project root:
 *
 *   /migrate           migrate the project repo to the latest structure
 *   /migrate status    report the current structure version, change nothing
 *
 * The exact command for an agent to run when its human instructs a
 * migration is `/migrate`. A failed migration changes nothing more than
 * the steps already applied, appends no changelog record, and reports the
 * runner's error (restore with git, re-run).
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { MigrationError, migrateToLatest, status } from "./core.ts";
import { MIGRATIONS } from "./migrations.ts";
import { resolveIdentity } from "./identity.ts";

const extensionDir = dirname(fileURLToPath(import.meta.url));
const checkoutRoot = resolve(join(extensionDir, ".."));

function renderMigrate(result: { applied: { version: number; migration: string }[]; currentVersion: number; fromVersion: number }): string {
  if (result.applied.length === 0) {
    return `Up to date: the project repo is at structure version ${String(result.currentVersion)}. Nothing to do.`;
  }
  const steps = result.applied.map((r) => `${String(r.version)} ${r.migration}`).join(", ");
  return `Migrated the project repo ${result.fromVersion === 0 ? "from void" : `from version ${String(result.fromVersion)}`} to version ${String(result.currentVersion)}: ${steps}. Commit the changelog and every changed file so the new structure version travels with the repo.`;
}

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("migrate", {
    description:
      "Migrate the session's project repo to the latest structure, or report its current structure version without changing anything: /migrate [status]",
    async handler(args: string, ctx: ExtensionCommandContext) {
      const verb = args.trim() === "status" ? "status" : "migrate";
      let text: string;
      let ok = true;
      try {
        if (verb === "status") {
          const result = status(ctx.cwd, MIGRATIONS);
          text =
            `Current structure version: ${result.currentVersion === "void" ? "void" : String(result.currentVersion)}` +
            ` (latest known: ${String(result.latestVersion)})` +
            (result.upToDate ? ". Up to date." : ". Not up to date; run /migrate.");
        } else {
          const identity = resolveIdentity(checkoutRoot);
          const excludedPaths = [extensionDir, join(checkoutRoot, "tests", "skill-migrate")];
          text = renderMigrate(migrateToLatest(ctx.cwd, MIGRATIONS, { identity, ctx: { excludedPaths } }));
        }
      } catch (error) {
        if (error instanceof MigrationError) {
          text = error.message;
        } else {
          text = `skill-migrate failed: ${(error as Error).message}`;
        }
        ok = false;
      }
      if (ctx.hasUI) {
        ctx.ui.notify(text, ok ? "info" : "warning");
      } else if (ok) {
        console.log(text);
      } else {
        console.error(text);
      }
    },
  });
}
