/**
 * Fixture: a tiny TypeScript repository with two git worktrees.
 *
 * main worktree:
 *   src/shared.ts   - helper(), ANSWER
 *   src/main.ts     - mainEntry() calls helper()
 *   src/mainonly.ts - mainOnlySymbol() (committed on main AFTER the
 *                     feature branch was cut, so it exists only in the
 *                     main worktree)
 *
 *   pkg/src/x.ts    - overloaded() (main only)
 *   lib/src/x.ts    - overloaded() (main only; same-named symbol in a
 *                     different sub-project, for sub-directory
 *                     disambiguation)
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

export const MAIN_ONLY = `export function mainOnlySymbol(): number {
  return 43;
}
`;

export const PKG_X = `export function overloaded(x: number): number {
  return x * 3;
}
`;

export const LIB_X = `export function overloaded(x: number): number {
  return x + 10;
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

  // Committed on main after the feature branch was cut: a sibling-only
  // file, present in the main worktree and its index only. Pins the
  // "sibling-only state reconciled away" direction of seed convergence.
  fs.writeFileSync(path.join(main, "src/mainonly.ts"), MAIN_ONLY);
  git(main, ["add", "-A"]);
  git(main, ["commit", "-q", "-m", "mainonly"]);

  // Two same-named symbols in two sub-projects of the main worktree,
  // committed on main after the feature branch was cut. From a call in
  // <main>/pkg, `src/x.ts` is pkg/src/x.ts in the root's form: it must
  // select that definition, not the same-named file elsewhere in the
  // index.
  fs.mkdirSync(path.join(main, "pkg", "src"), { recursive: true });
  fs.mkdirSync(path.join(main, "lib", "src"), { recursive: true });
  fs.writeFileSync(path.join(main, "pkg", "src", "x.ts"), PKG_X);
  fs.writeFileSync(path.join(main, "lib", "src", "x.ts"), LIB_X);
  git(main, ["add", "-A"]);
  git(main, ["commit", "-q", "-m", "overloaded"]);

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
