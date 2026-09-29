/**
 * Unit tests for the read-only resource resolver and the settings writer,
 * driven with temp-directory fixtures. The resolver must never install
 * missing packages: resolution is a pure read.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resourceDescription } from "../../extensions/resource-toggle/lib/description.ts";
import { displayNameFor, machineContextFor, resolveResources } from "../../extensions/resource-toggle/lib/resolver.ts";
import { writeSettings } from "../../extensions/resource-toggle/lib/writer.ts";
import { emptyScopeArrays, type SettingsState } from "../../extensions/resource-toggle/lib/types.ts";

const root = mkdtempSync(join(tmpdir(), "resource-toggle-resolver-"));
const agentDir = join(root, "agent");
const project = join(root, "project");
const projectPi = join(project, ".pi");

let prevHome = process.env.HOME;
beforeAll(() => {
  // Sandboxed HOME so auto-discovery of the real ~/.agents skills stays out.
  process.env.HOME = root;
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  mkdirSync(join(agentDir, "skills", "my-skill"), { recursive: true });
  mkdirSync(join(agentDir, "prompts"), { recursive: true });
  mkdirSync(join(agentDir, "themes"), { recursive: true });
  mkdirSync(join(agentDir, "extensions", "other"), { recursive: true });
  mkdirSync(join(projectPi, "extensions"), { recursive: true });

  writeFileSync(join(agentDir, "extensions", "a.ts"), "export default function (pi) {}\n");
  writeFileSync(
    join(agentDir, "extensions", "bom-shebang.ts"),
    "\uFEFF#!/usr/bin/env node\n/** BOM and shebang precede the comment. */\nexport default function (pi) {}\n",
  );
  writeFileSync(
    join(agentDir, "extensions", "c.ts"),
    "/**\n * Leading comment with   several   words\n * across lines. */\nexport default function (pi) {}\n",
  );
  writeFileSync(
    join(agentDir, "extensions", "late-comment.ts"),
    "export default function (pi) {}\n/** A comment that is not leading. */\n",
  );
  writeFileSync(join(agentDir, "extensions", "other", "index.ts"), "export default function (pi) {}\n");
  writeFileSync(
    join(agentDir, "skills", "my-skill", "SKILL.md"),
    "---\nname: custom-name\ndescription: fixture skill\n---\nBody.\n",
  );
  writeFileSync(join(agentDir, "prompts", "p.md"), "prompt body\n");
  writeFileSync(
    join(agentDir, "prompts", "d.md"),
    "---\ndescription: The prompt with a frontmatter description\n---\nprompt body\n",
  );
  mkdirSync(join(agentDir, "skills", "bad-skill"), { recursive: true });
  writeFileSync(join(agentDir, "skills", "bad-skill", "SKILL.md"), "---\nname: [unclosed\n---\nbody\n");
  writeFileSync(join(agentDir, "themes", "t.json"), "{}\n");
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "dark" }, null, 2) + "\n");
  writeFileSync(join(projectPi, "settings.json"), JSON.stringify({ extensions: [] }, null, 2) + "\n");
  writeFileSync(join(projectPi, "extensions", "b.ts"), "export default function (pi) {}\n");
});
afterAll(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  rmSync(root, { recursive: true, force: true });
});

const readGlobal = (): Record<string, unknown> => JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
const readProject = (): Record<string, unknown> => JSON.parse(readFileSync(join(projectPi, "settings.json"), "utf8"));

describe("resolveResources", () => {
  it("lists every loadable resource with scope and display names", async () => {
    const { resources } = await resolveResources({ cwd: project, agentDir, projectTrusted: true });
    const byName = new Map(resources.map((r) => [r.displayName, r]));
    expect(byName.get("a.ts")?.scope).toBe("user");
    expect(byName.get("other/index.ts")?.scope).toBe("user");
    expect(byName.get("b.ts")?.scope).toBe("project");
    expect(byName.get("custom-name")?.type).toBe("skills");
    expect(byName.get("p.md")?.type).toBe("prompts");
    expect(byName.get("t.json")?.type).toBe("themes");
    expect(byName.get("a.ts")?.enabled).toBe(true);
    expect(byName.get("a.ts")?.ownEnabled).toBe(true);
    // The resolved list carries the Resource description (ADR 0030).
    expect(byName.get("c.ts")?.description).toBe("Leading comment with several words across lines.");
    expect(byName.get("bom-shebang.ts")?.description).toBe("BOM and shebang precede the comment.");
    expect(byName.get("late-comment.ts")?.description).toBeUndefined();
    expect(byName.get("a.ts")?.description).toBeUndefined();
    expect(byName.get("custom-name")?.description).toBe("fixture skill");
    expect(byName.get("bad-skill")?.description).toBeUndefined();
    expect(byName.get("p.md")?.description).toBe("prompt body");
    expect(byName.get("d.md")?.description).toBe("The prompt with a frontmatter description");
    expect(byName.get("t.json")?.description).toBeUndefined();
  });

  it("derives the own-scope state from the settings patterns", async () => {
    const global = readGlobal();
    global.extensions = ["-extensions/a.ts"];
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify(global, null, 2) + "\n");
    const { resources } = await resolveResources({ cwd: project, agentDir, projectTrusted: true });
    const a = resources.find((r) => r.displayName === "a.ts");
    expect(a?.ownEnabled).toBe(false);
    expect(a?.enabled).toBe(false);
    // Restore.
    global.extensions = [];
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify(global, null, 2) + "\n");
  });

  it("a project shadow wins the effective state but keeps the own-scope identity", async () => {
    const projectSettings = readProject();
    projectSettings.extensions = [
      join(agentDir, "extensions", "a.ts"),
      `+${join(agentDir, "extensions", "a.ts")}`,
    ];
    writeFileSync(join(projectPi, "settings.json"), JSON.stringify(projectSettings, null, 2) + "\n");
    const { resources } = await resolveResources({ cwd: project, agentDir, projectTrusted: true });
    const a = resources.find((r) => r.displayName === "a.ts");
    expect(a?.scope).toBe("user");
    expect(a?.ownEnabled).toBe(true);
    expect(a?.enabled).toBe(true);
    // Restore.
    projectSettings.extensions = [];
    writeFileSync(join(projectPi, "settings.json"), JSON.stringify(projectSettings, null, 2) + "\n");
  });

  it("survives a stale package entry without installing it (skip callback)", async () => {
    const global = readGlobal();
    global.packages = ["definitely-not-a-real-pi-package-xyz"];
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify(global, null, 2) + "\n");
    const { resources } = await resolveResources({ cwd: project, agentDir, projectTrusted: true });
    expect(resources.length).toBeGreaterThan(0);
    expect(existsSync(join(agentDir, "node_modules"))).toBe(false);
    delete global.packages;
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify(global, null, 2) + "\n");
  });

  it("an untrusted project hides project resources and project settings", async () => {
    const { resources, settings } = await resolveResources({ cwd: project, agentDir, projectTrusted: false });
    expect(resources.find((r) => r.displayName === "b.ts")).toBeUndefined();
    expect(resources.find((r) => r.displayName === "a.ts")).toBeDefined();
    expect(settings.project.extensions).toEqual([]);
  });

  it("carries the raw settings arrays of both scopes", async () => {
    const global = readGlobal();
    global.extensions = ["+extensions/a.ts"];
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify(global, null, 2) + "\n");
    const { settings } = await resolveResources({ cwd: project, agentDir, projectTrusted: true });
    expect(settings.global.extensions).toEqual(["+extensions/a.ts"]);
    delete global.extensions;
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify(global, null, 2) + "\n");
  });
});

describe("writeSettings", () => {
  const from = (globalArrays?: Partial<SettingsState["global"]>, projectArrays?: Partial<SettingsState["project"]>): SettingsState => ({
    global: { ...emptyScopeArrays(), ...(globalArrays ?? {}) },
    project: { ...emptyScopeArrays(), ...(projectArrays ?? {}) },
  });

  it("writes only the changed arrays and keeps the rest of the file", async () => {
    const prev = from();
    const next = from({ extensions: ["extensions/a.ts"] });
    const outcome = await writeSettings({ cwd: project, agentDir, projectTrusted: true }, prev, next);
    expect(outcome).toEqual({ ok: true });
    const after = readGlobal();
    expect(after.extensions).toEqual(["extensions/a.ts"]);
    expect(after.theme).toBe("dark");
    // Restore.
    after.extensions = [];
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify(after, null, 2) + "\n");
  });

  it("writes project arrays to the project file", async () => {
    const prev = from();
    const next = from(undefined, { extensions: ["-extensions/b.ts"] });
    const outcome = await writeSettings({ cwd: project, agentDir, projectTrusted: true }, prev, next);
    expect(outcome).toEqual({ ok: true });
    expect(readProject().extensions).toEqual(["-extensions/b.ts"]);
  });

  it("a project write in an untrusted project is refused and says why", async () => {
    const prev = from();
    const next = from(undefined, { extensions: ["-extensions/b.ts"] });
    const before = readProject();
    const outcome = await writeSettings({ cwd: project, agentDir, projectTrusted: false }, prev, next);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("not trusted");
    expect(readProject()).toEqual(before);
  });

  it("a global write still succeeds in an untrusted project", async () => {
    const prev = from();
    const next = from({ extensions: ["+extensions/a.ts"] });
    const outcome = await writeSettings({ cwd: project, agentDir, projectTrusted: false }, prev, next);
    expect(outcome).toEqual({ ok: true });
    expect(readGlobal().extensions).toEqual(["+extensions/a.ts"]);
  });

  it("serializes writes: a second operation keeps the first one's entries", async () => {
    // First operation: disable a.ts globally and b.ts in the project.
    const onePrev = from();
    const oneNext = from({ extensions: ["+extensions/a.ts"] }, { extensions: ["-extensions/b.ts"] });
    await writeSettings({ cwd: project, agentDir, projectTrusted: true }, onePrev, oneNext);
    // Second operation: a fresh reader sees the first write, then disables
    // a skill. It must not clobber the first operation's entries.
    const twoPrev = from({ extensions: ["+extensions/a.ts"] }, { extensions: ["-extensions/b.ts"] });
    const twoNext = from(
      { extensions: ["+extensions/a.ts"], skills: ["-skills/my-skill/SKILL.md"] },
      { extensions: ["-extensions/b.ts"] },
    );
    await writeSettings({ cwd: project, agentDir, projectTrusted: true }, twoPrev, twoNext);
    const global = readGlobal();
    const projectSettings = readProject();
    expect(global.extensions).toEqual(["+extensions/a.ts"]);
    expect(global.skills).toEqual(["-skills/my-skill/SKILL.md"]);
    expect(projectSettings.extensions).toEqual(["-extensions/b.ts"]);
    // Restore both files.
    global.extensions = [];
    delete global.skills;
    projectSettings.extensions = [];
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify(global, null, 2) + "\n");
    writeFileSync(join(projectPi, "settings.json"), JSON.stringify(projectSettings, null, 2) + "\n");
  });
});

describe("displayNameFor", () => {
  it("uses the frontmatter name for skills", () => {
    expect(displayNameFor("skills", join(agentDir, "skills", "my-skill", "SKILL.md"))).toBe("custom-name");
  });

  it("keeps the folder for extensions outside the extensions directory", () => {
    expect(displayNameFor("extensions", join(agentDir, "extensions", "other", "index.ts"))).toBe("other/index.ts");
  });

  it("falls back to the file name", () => {
    expect(displayNameFor("extensions", join(agentDir, "extensions", "a.ts"))).toBe("a.ts");
    expect(displayNameFor("prompts", join(agentDir, "prompts", "p.md"))).toBe("p.md");
  });
});

describe("machineContextFor", () => {
  it("uses the pi config dir", () => {
    expect(machineContextFor("/proj", "/agent")).toEqual({ cwd: "/proj", agentDir: "/agent", configDir: ".pi" });
  });
});

describe("resourceDescription", () => {
  it("a skill gets its SKILL.md frontmatter description", () => {
    expect(resourceDescription("skills", join(agentDir, "skills", "my-skill", "SKILL.md"))).toBe("fixture skill");
  });

  it("a skill with malformed frontmatter gets no description", () => {
    expect(resourceDescription("skills", join(agentDir, "skills", "bad-skill", "SKILL.md"))).toBeUndefined();
  });

  it("a skill without a frontmatter description gets no description", () => {
    const path = join(agentDir, "skills", "my-skill", "SKILL.md");
    writeFileSync(path, "---\nname: custom-name\n---\nBody.\n");
    expect(resourceDescription("skills", path)).toBeUndefined();
    writeFileSync(path, "---\nname: custom-name\ndescription: fixture skill\n---\nBody.\n");
  });

  it("a prompt template uses the frontmatter description", () => {
    expect(resourceDescription("prompts", join(agentDir, "prompts", "d.md"))).toBe("The prompt with a frontmatter description");
  });

  it("a prompt template without a frontmatter description falls back to its first non-empty line", () => {
    expect(resourceDescription("prompts", join(agentDir, "prompts", "p.md"))).toBe("prompt body");
    const path = join(agentDir, "prompts", "first-line.md");
    writeFileSync(path, "\n   \n  The first non-empty line.\nsecond line\n");
    expect(resourceDescription("prompts", path)).toBe("The first non-empty line.");
    rmSync(path);
  });

  it("a prompt template with malformed frontmatter falls back to the first non-empty line", () => {
    const path = join(agentDir, "prompts", "bad.md");
    writeFileSync(path, "---\ndescription: [unclosed\n---\nthe body line\n");
    expect(resourceDescription("prompts", path)).toBe("the body line");
    rmSync(path);
  });

  it("an extension gets the leading block comment, markers stripped and whitespace collapsed", () => {
    expect(resourceDescription("extensions", join(agentDir, "extensions", "c.ts"))).toBe(
      "Leading comment with several words across lines.",
    );
  });

  it("an extension comment preceded by a BOM and a shebang still counts as leading", () => {
    expect(resourceDescription("extensions", join(agentDir, "extensions", "bom-shebang.ts"))).toBe(
      "BOM and shebang precede the comment.",
    );
  });

  it("a comment that is not leading gets no description", () => {
    expect(resourceDescription("extensions", join(agentDir, "extensions", "late-comment.ts"))).toBeUndefined();
  });

  it("a code-first extension file gets no description", () => {
    expect(resourceDescription("extensions", join(agentDir, "extensions", "a.ts"))).toBeUndefined();
  });

  it("a theme has no description", () => {
    expect(resourceDescription("themes", join(agentDir, "themes", "t.json"))).toBeUndefined();
  });

  it("an unreadable file gets no description", () => {
    expect(resourceDescription("extensions", join(agentDir, "extensions", "missing.ts"))).toBeUndefined();
  });
});
