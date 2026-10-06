/**
 * skill-migrate identity tests: the git commit SHA, with the package
 * version as the fallback when the checkout is not git.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MigrationError } from "../../extensions/skill-migrate/core.ts";
import { resolveIdentity } from "../../extensions/skill-migrate/identity.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "skill-migrate-identity-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("resolveIdentity", () => {
  it("returns the git commit SHA for a git checkout", () => {
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root, stdio: "ignore" });
    writeFileSync(join(root, "file.txt"), "x\n");
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: root, stdio: "ignore" });
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    expect(resolveIdentity(root)).toBe(sha);
  });

  it("falls back to the package version when the checkout is not git", () => {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", version: "9.9.9" }));
    expect(resolveIdentity(root)).toBe("9.9.9");
  });

  it("throws a clear error when neither git nor a version is available", () => {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture" }));
    expect(() => resolveIdentity(root)).toThrowError(MigrationError);
    expect(() => resolveIdentity(root)).toThrowError(/not a git checkout/);
  });
});
