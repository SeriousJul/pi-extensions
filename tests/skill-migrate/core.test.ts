/**
 * skill-migrate core tests. Exercises the deterministic core through its
 * public seam only: build a fixture repo in a temp directory, call
 * status and migrateToLatest, and assert on the resulting files and
 * changelog content. No test reaches inside a migration step or into the
 * changelog writer.
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CHANGELOG_RELATIVE_PATH,
  MigrationError,
  migrateToLatest,
  status,
  type Changelog,
  type MigrationRecord,
} from "../../extensions/skill-migrate/core.ts";
import { MIGRATIONS } from "../../extensions/skill-migrate/migrations.ts";

const IDENTITY = "test-identity";
const FIXED_NOW = () => new Date("2026-07-01T12:00:00.000Z");
const FIXED_DATE_TIME = "2026-07-01T12:00:00.000Z";

let root: string;

function file(rel: string, content: string): string {
  const path = join(root, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  return path;
}

function readChangelogFile(): Changelog | null {
  const path = join(root, CHANGELOG_RELATIVE_PATH);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as Changelog;
}

function expectRecords(versions: number[], names: string[]): void {
  const changelog = readChangelogFile();
  expect(changelog).not.toBeNull();
  const records = changelog!.migrations;
  expect(records.map((r) => r.version)).toEqual(versions);
  for (const record of records) {
    expect(record.migration).toEqual(names[records.indexOf(record)]);
    expect(record.identity).toEqual(IDENTITY);
    expect(record.dateTime).toEqual(FIXED_DATE_TIME);
  }
}

function migrate(opts: { now?: () => Date; excludedPaths?: string[] } = {}): ReturnType<typeof migrateToLatest> {
  return migrateToLatest(root, MIGRATIONS, {
    identity: IDENTITY,
    now: opts.now ?? FIXED_NOW,
    ctx: { excludedPaths: opts.excludedPaths },
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "skill-migrate-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("status", () => {
  it("reports void for a repo without a changelog", () => {
    file("README.md", "# fixture");
    const result = status(root, MIGRATIONS);
    expect(result.currentVersion).toBe("void");
    expect(result.records).toEqual([]);
    expect(result.latestVersion).toBe(2);
    expect(result.upToDate).toBe(false);
  });

  it("reports version 1 with its single record", () => {
    file("CONTEXT.md", "# old layout, already renamed by hand to nothing yet");
    const changelog: Changelog = {
      migrations: [{ version: 1, migration: "create-changelog", identity: IDENTITY, dateTime: FIXED_DATE_TIME }],
    };
    file(CHANGELOG_RELATIVE_PATH, JSON.stringify(changelog, null, 2) + "\n");

    const result = status(root, MIGRATIONS);

    expect(result.currentVersion).toBe(1);
    expect(result.records).toHaveLength(1);
    expect(result.records[0].migration).toBe("create-changelog");
    expect(result.upToDate).toBe(false);
    // status changed nothing
    expect(readChangelogFile()!.migrations).toHaveLength(1);
  });

  it("reports version 2 and up to date after a full run", () => {
    file("CONTEXT.md", "# glossary");
    migrate();
    const result = status(root, MIGRATIONS);
    expect(result.currentVersion).toBe(2);
    expect(result.records).toHaveLength(2);
    expect(result.upToDate).toBe(true);
  });
});

describe("migrateToLatest", () => {
  it("runs void to 1 to 2 in order on a single-context fixture", () => {
    file("CONTEXT.md", "# Glossary\n\nThe **Order** is a CONTEXT.md term. See CONTEXT-MAP.md for the layout.\n");
    file("docs/notes.md", "Read CONTEXT.md before design work.\n");

    const result = migrate();

    expect(result.fromVersion).toBe(0);
    expect(result.currentVersion).toBe(2);
    expect(result.applied.map((r) => r.version)).toEqual([1, 2]);
    expectRecords([1, 2], ["create-changelog", "glossary-rename"]);

    expect(existsSync(join(root, "GLOSSARY.md"))).toBe(true);
    expect(existsSync(join(root, "CONTEXT.md"))).toBe(false);
    const glossary = readFileSync(join(root, "GLOSSARY.md"), "utf8");
    expect(glossary).toContain("GLOSSARY.md term. See GLOSSARY-MAP.md");
    expect(glossary).not.toContain("CONTEXT.md");
    expect(readFileSync(join(root, "docs/notes.md"), "utf8")).toContain("Read GLOSSARY.md before design work.");
  });

  it("is a no-op on an already-current repo", () => {
    file("CONTEXT.md", "# Glossary\n");
    file("docs/notes.md", "See CONTEXT.md.\n");
    migrate();
    const before = {
      changelog: readFileSync(join(root, CHANGELOG_RELATIVE_PATH), "utf8"),
      notes: readFileSync(join(root, "docs/notes.md"), "utf8"),
      mtime: statSync(join(root, CHANGELOG_RELATIVE_PATH)).mtimeMs,
    };

    const result = migrate();

    expect(result.fromVersion).toBe(2);
    expect(result.currentVersion).toBe(2);
    expect(result.applied).toEqual([]);
    expect(readFileSync(join(root, CHANGELOG_RELATIVE_PATH), "utf8")).toBe(before.changelog);
    expect(readFileSync(join(root, "docs/notes.md"), "utf8")).toBe(before.notes);
    expect(statSync(join(root, CHANGELOG_RELATIVE_PATH)).mtimeMs).toBe(before.mtime);
  });

  it("still completes migration 2 for a repo without any old files", () => {
    file("README.md", "The domain docs live in CONTEXT.md and CONTEXT-MAP.md.\n");

    const result = migrate();

    expect(result.applied.map((r) => r.version)).toEqual([1, 2]);
    expectRecords([1, 2], ["create-changelog", "glossary-rename"]);
    expect(readFileSync(join(root, "README.md"), "utf8")).toBe(
      "The domain docs live in GLOSSARY.md and GLOSSARY-MAP.md.\n",
    );
    expect(existsSync(join(root, "GLOSSARY.md"))).toBe(false); // nothing to rename, nothing invented
  });

  it("renames per-context glossaries by the local paths the map names (multi-context)", () => {
    file("CONTEXT-MAP.md", ["# Context Map", "", "- [Ordering](./src/ordering/CONTEXT.md): orders", "- [Billing](./src/billing/CONTEXT.md): invoices", "- [Guide](https://example.com/orders.html): external link, never a rename target", ""].join("\n"));
    file("src/ordering/CONTEXT.md", "# Ordering glossary\n");
    file("src/billing/CONTEXT.md", "# Billing glossary\n");
    file("src/billing/ADR.md", "See CONTEXT.md.\n");

    const result = migrate();

    expect(result.applied.map((r) => r.version)).toEqual([1, 2]);
    expect(existsSync(join(root, "GLOSSARY-MAP.md"))).toBe(true);
    expect(existsSync(join(root, "CONTEXT-MAP.md"))).toBe(false);
    expect(existsSync(join(root, "src/ordering/GLOSSARY.md"))).toBe(true);
    expect(existsSync(join(root, "src/billing/GLOSSARY.md"))).toBe(true);
    expect(existsSync(join(root, "src/ordering/CONTEXT.md"))).toBe(false);
    expect(existsSync(join(root, "src/billing/CONTEXT.md"))).toBe(false);
    const map = readFileSync(join(root, "GLOSSARY-MAP.md"), "utf8");
    expect(map).toContain("](./src/ordering/GLOSSARY.md)");
    expect(map).toContain("](./src/billing/GLOSSARY.md)");
    // the external non-.md link is never a rename target; the sibling doc is rewritten
    expect(map).toContain("https://example.com/orders.html");
    expect(readFileSync(join(root, "src/billing/ADR.md"), "utf8")).toContain("See GLOSSARY.md.");
  });

  it("completes a half-finished rename where the map already carries the new references", () => {
    file("GLOSSARY-MAP.md", "# Map\n\n- [Ordering](./src/ordering/GLOSSARY.md): orders\n");
    file("src/ordering/CONTEXT.md", "# Ordering glossary\n");

    const result = migrate();

    expect(result.applied.map((r) => r.version)).toEqual([1, 2]);
    expect(existsSync(join(root, "src/ordering/GLOSSARY.md"))).toBe(true);
    expect(existsSync(join(root, "src/ordering/CONTEXT.md"))).toBe(false);
    expectRecords([1, 2], ["create-changelog", "glossary-rename"]);
  });

  it("aborts on ambiguous root state (both old and new present) and appends nothing", () => {
    file("CONTEXT.md", "# old");
    file("GLOSSARY.md", "# new");
    const changelog: Changelog = {
      migrations: [{ version: 1, migration: "create-changelog", identity: IDENTITY, dateTime: FIXED_DATE_TIME }],
    };
    file(CHANGELOG_RELATIVE_PATH, JSON.stringify(changelog, null, 2) + "\n");

    expect(() => migrate()).toThrowError(MigrationError);
    expect(() => migrate()).toThrowError(/ambiguous state: both CONTEXT\.md and GLOSSARY\.md/);
    expect(readChangelogFile()!.migrations).toHaveLength(1);
  });

  it("aborts on ambiguous per-context state named by the map", () => {
    file("CONTEXT-MAP.md", "# Map\n\n- [Ordering](./src/ordering/CONTEXT.md): orders\n");
    file("src/ordering/CONTEXT.md", "# old");
    file("src/ordering/GLOSSARY.md", "# new");
    const changelog: Changelog = {
      migrations: [{ version: 1, migration: "create-changelog", identity: IDENTITY, dateTime: FIXED_DATE_TIME }],
    };
    file(CHANGELOG_RELATIVE_PATH, JSON.stringify(changelog, null, 2) + "\n");

    expect(() => migrate()).toThrowError(/ambiguous state: both .*CONTEXT\.md and .*GLOSSARY\.md/);
    expect(readChangelogFile()!.migrations).toHaveLength(1);
    // precondition failure: the tree is untouched
    expect(existsSync(join(root, "src/ordering/CONTEXT.md"))).toBe(true);
    expect(existsSync(join(root, "CONTEXT-MAP.md"))).toBe(true);
  });

  it("leaves the changelog untouched when the migration fails mid-step", () => {
    // The map references a per-context glossary whose target name is taken
    // by a directory, so the rename fails after the root rename has run.
    file("CONTEXT-MAP.md", "# Map\n\n- [Ordering](./src/ordering/CONTEXT.md): orders\n");
    file("src/ordering/CONTEXT.md", "# Ordering glossary\n");
    mkdirSync(join(root, "src", "ordering", "GLOSSARY.md")); // a directory, not a file
    const changelog: Changelog = {
      migrations: [{ version: 1, migration: "create-changelog", identity: IDENTITY, dateTime: FIXED_DATE_TIME }],
    };
    file(CHANGELOG_RELATIVE_PATH, JSON.stringify(changelog, null, 2) + "\n");

    expect(() => migrate()).toThrowError(/Migration 2 \(glossary-rename\) failed while applying/);
    expect(() => migrate()).toThrowError(/restore|git restore/i);
    expect(readChangelogFile()!.migrations).toHaveLength(1);
    // the tree is partly changed on purpose: git is the rollback layer
    expect(existsSync(join(root, "GLOSSARY-MAP.md"))).toBe(true);
  });

  it("rewrites references only in text files the spec allows", () => {
    file("CONTEXT.md", "# Glossary\n");
    file("docs/keep.md", "MY-CONTEXT.md is an unrelated file name.\n");
    file("package-lock.json", "{ \"note\": \"CONTEXT.md\" }\n");
    file("node_modules/pkg/readme.md", "CONTEXT.md\n");
    file("dist/app.js", "var x = 'CONTEXT.md';\n");
    file("docs/binary.md", "CONTEXT.md");
    // append a null byte so the file is binary
    appendFileSync(join(root, "docs/binary.md"), Buffer.from([0x00, 0x01, 0x02]));
    const excludedDir = join(root, "tools");
    mkdirSync(excludedDir, { recursive: true });
    file("tools/self.md", "CONTEXT.md\n");

    migrate({ excludedPaths: [excludedDir] });

    expect(readFileSync(join(root, "docs/keep.md"), "utf8")).toContain("MY-CONTEXT.md");
    expect(readFileSync(join(root, "package-lock.json"), "utf8")).toBe("{ \"note\": \"CONTEXT.md\" }\n");
    expect(readFileSync(join(root, "node_modules/pkg/readme.md"), "utf8")).toBe("CONTEXT.md\n");
    expect(readFileSync(join(root, "dist/app.js"), "utf8")).toBe("var x = 'CONTEXT.md';\n");
    const binary = readFileSync(join(root, "docs/binary.md"));
    expect(binary.subarray(0, 10).toString("utf8")).toBe("CONTEXT.md");
    expect(readFileSync(join(excludedDir, "self.md"), "utf8")).toBe("CONTEXT.md\n");
  });

  it("rewrites CONTEXT-FORMAT.md and CONTEXT-MAP.md tokens; only the map file itself is renamed", () => {
    file("CONTEXT.md", "# Glossary\n");
    file("CONTEXT-MAP.md", "# Map\n\n- [Ordering](./src/ordering/CONTEXT.md): orders\n");
    file("src/ordering/CONTEXT.md", "# Ordering\n");
    file("CONTEXT-FORMAT.md", "Format rules. See CONTEXT-MAP.md and CONTEXT.md.\n");
    file("docs/agents.md", "Follow CONTEXT-FORMAT.md.\n");

    migrate();

    // the root map is renamed; no other file is renamed, however it is named
    expect(existsSync(join(root, "GLOSSARY-MAP.md"))).toBe(true);
    expect(existsSync(join(root, "CONTEXT-FORMAT.md"))).toBe(true);
    expect(existsSync(join(root, "GLOSSARY-FORMAT.md"))).toBe(false);
    // but every reference to the three old names is rewritten
    expect(readFileSync(join(root, "CONTEXT-FORMAT.md"), "utf8")).toBe("Format rules. See GLOSSARY-MAP.md and GLOSSARY.md.\n");
    expect(readFileSync(join(root, "docs/agents.md"), "utf8")).toBe("Follow GLOSSARY-FORMAT.md.\n");
  });
});

describe("changelog validation", () => {
  it("rejects a changelog that is not JSON", () => {
    file(CHANGELOG_RELATIVE_PATH, "not json");
    expect(() => status(root, MIGRATIONS)).toThrowError(/not valid JSON/);
  });

  it("rejects a changelog without the migrations array", () => {
    file(CHANGELOG_RELATIVE_PATH, JSON.stringify({ something: "else" }));
    expect(() => status(root, MIGRATIONS)).toThrowError(/missing the migrations array/);
  });

  it("rejects a record with a non-integer version", () => {
    file(
      CHANGELOG_RELATIVE_PATH,
      JSON.stringify({ migrations: [{ version: "one", migration: "create-changelog", identity: IDENTITY, dateTime: FIXED_DATE_TIME }] }),
    );
    expect(() => status(root, MIGRATIONS)).toThrowError(/record 1/);
  });

  it("rejects a gap in the version sequence", () => {
    file(
      CHANGELOG_RELATIVE_PATH,
      JSON.stringify({
        migrations: [
          { version: 1, migration: "create-changelog", identity: IDENTITY, dateTime: FIXED_DATE_TIME },
          { version: 3, migration: "glossary-rename", identity: IDENTITY, dateTime: FIXED_DATE_TIME },
        ],
      }),
    );
    expect(() => migrate()).toThrowError(/versions must be contiguous/);
  });
});
