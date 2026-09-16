/**
 * Unit tests for the name matcher: display name first (exact, then prefix),
 * then path substring; a match must be unique.
 */
import { describe, expect, it } from "vitest";
import { matchResource } from "../../extensions/resource-toggle/lib/matcher.ts";
import type { ResourceInfo } from "../../extensions/resource-toggle/lib/types.ts";

const res = (partial: Partial<ResourceInfo> & { path: string; displayName: string }): ResourceInfo => ({
  type: partial.type ?? "extensions",
  path: partial.path,
  displayName: partial.displayName,
  scope: partial.scope ?? "user",
  origin: "top-level",
  source: "auto",
  baseDir: partial.baseDir,
  enabled: true,
  ownEnabled: true,
});

const resources = [
  res({ path: "/home/u/.pi/agent/extensions/dummy.ts", displayName: "dummy.ts" }),
  res({ path: "/proj/.pi/extensions/dummy2.ts", displayName: "dummy2.ts", scope: "project" }),
  res({ path: "/home/u/.pi/agent/skills/my-skill/SKILL.md", displayName: "my-skill", type: "skills" }),
  res({ path: "/home/u/.pi/agent/themes/dark.json", displayName: "dark.json", type: "themes" }),
];

describe("matchResource", () => {
  it("exact display name wins", () => {
    const match = matchResource(resources, "dummy.ts");
    expect(match).toEqual({ status: "ok", resource: resources[0] });
  });

  it("matching is case-insensitive", () => {
    expect(matchResource(resources, "DUMMY.TS").status).toBe("ok");
    expect(matchResource(resources, "My-Skill").status).toBe("ok");
  });

  it("a unique name prefix resolves", () => {
    expect(matchResource(resources, "my-s").status).toBe("ok");
    expect(matchResource(resources, "dark").status).toBe("ok");
  });

  it("a non-unique prefix is ambiguous and lists its candidates", () => {
    const match = matchResource(resources, "dummy");
    expect(match.status).toBe("ambiguous");
    if (match.status === "ambiguous") {
      expect(match.candidates.map((c) => c.displayName).sort()).toEqual(["dummy.ts", "dummy2.ts"]);
    }
  });

  it("an exact name hit on two resources is ambiguous", () => {
    const two = [
      res({ path: "/a/x/extensions/read.ts", displayName: "read.ts" }),
      res({ path: "/b/x/extensions/read.ts", displayName: "read.ts", scope: "project" }),
    ];
    expect(matchResource(two, "read.ts").status).toBe("ambiguous");
  });

  it("a path substring resolves when the display name does not match", () => {
    expect(matchResource(resources, "my-skill/SKILL.md").status).toBe("ok");
    expect(matchResource(resources, ".pi/agent/themes").status).toBe("ok");
  });

  it("a path substring hit on many resources is ambiguous", () => {
    const match = matchResource(resources, "/home/u/.pi/agent");
    expect(match.status).toBe("ambiguous");
    if (match.status === "ambiguous") expect(match.candidates.length).toBe(3);
  });

  it("no match says none", () => {
    expect(matchResource(resources, "nope")).toEqual({ status: "none" });
    expect(matchResource(resources, "   ")).toEqual({ status: "none" });
  });
});
