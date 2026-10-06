/**
 * skill-migrate: the extension identity.
 *
 * A changelog record names the pi-extensions checkout that applied the
 * step, so every step is reproducible against the exact migration code:
 * the git commit SHA of the checkout. The git lookup is anchored to the
 * checkout's own toplevel: when the checkout is an installed package
 * inside a consumer git repo, `git rev-parse` would walk up to the
 * consumer's toplevel and record the consumer's SHA instead of the
 * package version, so the SHA is trusted only when the checkout is the
 * toplevel itself. Otherwise (not a git checkout, or not the toplevel),
 * the package version from the manifest is recorded.
 */
import { execFileSync } from "node:child_process";
import { realpathSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { MigrationError } from "./core.ts";

export function resolveIdentity(checkoutRoot: string): string {
  const root = resolve(checkoutRoot);
  try {
    const toplevel = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (realpathSync(toplevel) === realpathSync(root)) {
      const sha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (sha) return sha;
    }
  } catch {
    // Not a git checkout, or the checkout sits inside another repo
    // (an installed package): fall through to the package version.
  }
  try {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: unknown };
    if (typeof manifest.version === "string" && manifest.version.length > 0) return manifest.version;
  } catch {
    // No readable manifest version: fall through.
  }
  throw new MigrationError(
    `Cannot determine the extension identity of ${root}: it is not its own git toplevel and its package.json carries no version.`,
  );
}
