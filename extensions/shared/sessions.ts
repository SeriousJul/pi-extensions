/**
 * The shared session-tree walker. Extensions that read pi's session files
 * (the Usage scan, the initial-context tool usage scan) all walk the same
 * tree the same way, so the walking lives here once.
 *
 * Layout: the root holds one subdirectory per working directory, and each
 * subdirectory holds the `*.jsonl` session files for that directory.
 */
import { homedir } from "node:os";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Environment variable that points the walk at another sessions tree. */
export const SESSIONS_DIR_ENV = "PI_SESSIONS_DIR";

/** The sessions root: the env override, else `~/.pi/agent/sessions`. */
export function defaultSessionsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env[SESSIONS_DIR_ENV] || join(homedir(), ".pi", "agent", "sessions");
}

/** One session file with the stat facts a per-file cache keys on. */
export interface SessionFile {
  file: string;
  mtimeMs: number;
  size: number;
}

/**
 * Every session file in the tree. A missing root, a missing subdirectory,
 * or a file that vanished mid-walk is skipped, so a walk never throws on a
 * half-written tree.
 */
export function listSessionFiles(root: string): SessionFile[] {
  const out: SessionFile[] = [];
  let dirNames: string[];
  try {
    dirNames = readdirSync(root);
  } catch {
    return out;
  }
  for (const dirName of dirNames) {
    const dir = join(root, dirName);
    let st;
    try {
      st = statSync(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const file = join(dir, name);
      let fst;
      try {
        fst = statSync(file);
      } catch {
        continue;
      }
      out.push({ file, mtimeMs: fst.mtimeMs, size: fst.size });
    }
  }
  return out;
}

/** The file's text, or undefined when a concurrent write lost the race. */
export function readSessionText(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}
