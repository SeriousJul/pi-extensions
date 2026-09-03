/**
 * Fixture: a tiny TypeScript repository with two git worktrees.
 *
 * main worktree:
 *   src/shared.ts  - helper(), ANSWER
 *   src/main.ts    - mainEntry() calls helper()
 *
 * feature worktree (branch `feature`), placed under a nested foreign
 * directory (`<base>/elsewhere/feature`) to prove placement irrelevance:
 *   src/feature.ts - featureOnlySymbol(), helper()  (exists only on the
 *                   branch; helper is overloaded with src/shared.ts's helper,
 *                   which exercises file/line disambiguation)
 *   src/main.ts    - mainEntry() also calls featureOnlySymbol()
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const MAIN_ENTRY = `import { helper } from "./shared";

export function mainEntry(): number {
  return helper(1);
}
`;

export const FEATURE_MAIN_ENTRY = `import { helper } from "./shared";
import { featureOnlySymbol } from "./feature";

export function mainEntry(): number {
  return helper(1) + featureOnlySymbol().length;
}
`;

export const SHARED = `export const ANSWER = 42;

export function helper(x: number): number {
  return x + ANSWER;
}
`;

export const FEATURE_ONLY = `export function featureOnlySymbol(): string {
  return "feature";
}

export function helper(x: number): number {
  return x * 2;
}
`;

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

export interface Fixture {
  base: string;
  main: string;
  feature: string;
  cleanup: () => void;
}

export function buildFixture(): Fixture {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-pi-"));
  const main = path.join(base, "main");
  // Nested under a foreign directory, not a sibling of main: the extension
  // must find this worktree and seed it no matter where it lives.
  const feature = path.join(base, "elsewhere", "feature");
  fs.mkdirSync(path.join(main, "src"), { recursive: true });

  const write = (file: string, content: string): void => {
    fs.writeFileSync(path.join(main, file), content);
  };
  write("package.json", JSON.stringify({ name: "fixture", version: "0.0.0" }));
  write("tsconfig.json", JSON.stringify({ compilerOptions: {} }));
  write("src/shared.ts", SHARED);
  write("src/main.ts", MAIN_ENTRY);

  git(main, ["init", "-q"]);
  git(main, ["config", "user.email", "test@example.com"]);
  git(main, ["config", "user.name", "Fixture Test"]);
  git(main, ["add", "-A"]);
  git(main, ["commit", "-q", "-m", "main"]);

  // Feature branch worktree with a branch-only file and a modified main.ts.
  git(main, ["worktree", "add", "-q", "-b", "feature", feature]);
  fs.writeFileSync(path.join(feature, "src/feature.ts"), FEATURE_ONLY);
  fs.writeFileSync(path.join(feature, "src/main.ts"), FEATURE_MAIN_ENTRY);
  git(feature, ["add", "-A"]);
  git(feature, ["commit", "-q", "-m", "feature"]);

  const cleanup = (): void => {
    try {
      git(main, ["worktree", "remove", "--force", feature]);
    } catch {
      // already gone
    }
    fs.rmSync(base, { recursive: true, force: true });
  };

  return { base, main, feature, cleanup };
}
