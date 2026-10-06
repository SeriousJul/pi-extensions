/**
 * skill-migrate: the extension identity.
 *
 * A changelog record names the pi-extensions checkout that applied the
 * step, so every step is reproducible against the exact migration code:
 * the git commit SHA of the checkout. When the checkout is not git (for
 * example an installed package copy), the package version from the
 * manifest is recorded instead.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MigrationError } from "./core.ts";

export function resolveIdentity(checkoutRoot: string): string {
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: checkoutRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (sha) return sha;
  } catch {
    // Not a git checkout (or git missing): fall through to the package version.
  }
  try {
    const manifest = JSON.parse(readFileSync(join(checkoutRoot, "package.json"), "utf8")) as { version?: unknown };
    if (typeof manifest.version === "string" && manifest.version.length > 0) return manifest.version;
  } catch {
    // No readable manifest version: fall through.
  }
  throw new MigrationError(
    `Cannot determine the extension identity of ${checkoutRoot}: it is not a git checkout and its package.json carries no version.`,
  );
}
