/**
 * skill-migrate command tests: the pi slash command (index.ts) is thin
 * wiring over the core, and this pins it with a mock pi and fixture
 * project roots: exactly one command is registered, the status and
 * migrate verbs render through the UI, a failed migration reports a
 * warning, and the no-UI branch goes to the console instead.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { CHANGELOG_RELATIVE_PATH } from "../../extensions/skill-migrate/core.ts";
import skillMigrate from "../../extensions/skill-migrate/index.ts";

interface CommandDef {
  description: string;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

interface Notify {
  text: string;
  severity: string;
}

let root: string;
let registered: Record<string, CommandDef>;

function register(): void {
  registered = {};
  const pi = {
    registerCommand: (name: string, def: CommandDef) => {
      registered[name] = def;
    },
  } as unknown as ExtensionAPI;
  skillMigrate(pi);
}

function makeCtx(cwd: string, hasUI: boolean, notifies: Notify[]): ExtensionCommandContext {
  return {
    cwd,
    hasUI,
    ui: {
      notify: (text: string, severity: string) => {
        notifies.push({ text, severity });
      },
    },
  } as unknown as ExtensionCommandContext;
}

function file(rel: string, content: string): void {
  const path = join(root, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

async function run(args: string, hasUI = true): Promise<Notify[]> {
  const notifies: Notify[] = [];
  await registered.migrate.handler(args, makeCtx(root, hasUI, notifies));
  return notifies;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "skill-migrate-command-"));
  register();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("registration", () => {
  it("registers exactly one command, named migrate", () => {
    expect(Object.keys(registered)).toEqual(["migrate"]);
    expect(registered.migrate.description.length).toBeGreaterThan(0);
  });
});

describe("status verb", () => {
  it("reports void for a repo without a changelog and changes nothing", async () => {
    file("README.md", "# fixture\n");
    const notifies = await run("status");
    expect(notifies).toHaveLength(1);
    expect(notifies[0].text).toContain("Current structure version: void");
    expect(notifies[0].severity).toBe("info");
    expect(existsSync(join(root, CHANGELOG_RELATIVE_PATH))).toBe(false);
  });
});

describe("migrate verb", () => {
  it("migrates the project root and reports the applied steps", async () => {
    file("CONTEXT.md", "# Glossary\n");
    const notifies = await run("");
    expect(notifies).toHaveLength(1);
    expect(notifies[0].text).toContain("Migrated");
    expect(notifies[0].severity).toBe("info");
    expect(existsSync(join(root, "GLOSSARY.md"))).toBe(true);
    const changelog = JSON.parse(readFileSync(join(root, CHANGELOG_RELATIVE_PATH), "utf8")) as {
      migrations: { version: number; identity: string }[];
    };
    expect(changelog.migrations.map((r) => r.version)).toEqual([1, 2]);
    expect(changelog.migrations.every((r) => r.identity.length > 0)).toBe(true);
  });

  it("reports an ambiguous tree as a warning and appends nothing", async () => {
    file("CONTEXT.md", "# old\n");
    file("GLOSSARY.md", "# new\n");
    file(
      CHANGELOG_RELATIVE_PATH,
      JSON.stringify(
        { migrations: [{ version: 1, migration: "create-changelog", identity: "x", dateTime: "2026-01-01T00:00:00.000Z" }] },
        null,
        2,
      ) + "\n",
    );
    const notifies = await run("");
    expect(notifies).toHaveLength(1);
    expect(notifies[0].text).toContain("ambiguous state");
    expect(notifies[0].severity).toBe("warning");
  });
});

describe("no-UI branch", () => {
  it("sends status output to the console", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    file("README.md", "# fixture\n");
    await run("status", false);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toContain("Current structure version: void");
    log.mockRestore();
  });

  it("sends a failure to the console error stream", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    file("CONTEXT.md", "# old\n");
    file("GLOSSARY.md", "# new\n");
    await run("", false);
    expect(log).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0][0])).toContain("ambiguous state");
    err.mockRestore();
    log.mockRestore();
  });
});
