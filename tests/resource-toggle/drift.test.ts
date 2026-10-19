/**
 * Unit tests for the settings drift check: a pure function over the raw
 * settings documents and the resolved resource catalog, driven with
 * fixture documents and a stubbed path existence check. Asserted on the
 * findings list, not on the steps.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  computeDrift,
  driftNoticeText,
  renderDriftSection,
  settingsKeyForExtension,
} from "../../extensions/resource-toggle/lib/drift.ts";
import type {
  DriftFinding,
  MachineContext,
  RawSettingsDocument,
  ResourceInfo,
  ScopeState,
  SettingsState,
} from "../../extensions/resource-toggle/lib/types.ts";
import { emptyScopeState } from "../../extensions/resource-toggle/lib/types.ts";

const machine: MachineContext = { cwd: "/proj", agentDir: "/home/u/.pi/agent", configDir: ".pi" };

const res = (partial: Partial<ResourceInfo> & { path: string; displayName: string }): ResourceInfo => ({
  type: partial.type ?? "extensions",
  path: partial.path,
  displayName: partial.displayName,
  scope: partial.scope ?? "user",
  origin: partial.origin ?? "top-level",
  source: partial.source ?? "auto",
  baseDir: partial.baseDir,
  enabled: partial.enabled ?? true,
  ownEnabled: partial.ownEnabled ?? partial.enabled ?? true,
});

// The catalog: a global extension, a disabled global extension, a project
// extension, a package extension, and a disabled package extension.
const catalog: ResourceInfo[] = [
  res({ path: "/home/u/.pi/agent/extensions/dummy.ts", displayName: "dummy.ts" }),
  res({ path: "/home/u/.pi/agent/extensions/model-router.ts", displayName: "model-router.ts", enabled: false, ownEnabled: false }),
  res({ path: "/proj/.pi/extensions/proj.ts", displayName: "proj.ts", scope: "project" }),
  res({ path: "/home/u/pkg/extensions/usage.ts", displayName: "usage.ts", origin: "package", source: "/home/u/pkg", baseDir: "/home/u/pkg" }),
  res({ path: "/home/u/pkg/extensions/off.ts", displayName: "off.ts", origin: "package", source: "/home/u/pkg", baseDir: "/home/u/pkg", enabled: false, ownEnabled: false }),
];

const state = (global: Partial<ScopeState> = {}, project: Partial<ScopeState> = {}): SettingsState => ({
  global: { ...emptyScopeState(), ...global },
  project: { ...emptyScopeState(), ...project },
});

const raw = (
  global: RawSettingsDocument = {},
  project: RawSettingsDocument = {},
): { global: RawSettingsDocument; project: RawSettingsDocument } => ({ global, project });

// The files on disk: the catalog's files exist, everything else does not.
const onDisk = new Set<string>(catalog.map((r) => r.path));

const options = (projectTrusted = true) => ({
  machine,
  projectTrusted,
  pathExists: (path: string): boolean => onDisk.has(path),
});

const kinds = (findings: DriftFinding[]): DriftFinding["kind"][] => findings.map((f) => f.kind);

describe("settingsKeyForExtension", () => {
  it("maps hyphenated names to camelCase", () => {
    expect(settingsKeyForExtension("model-router")).toBe("modelRouter");
    expect(settingsKeyForExtension("camel-ext")).toBe("camelExt");
  });
  it("maps single-word names to themselves", () => {
    expect(settingsKeyForExtension("dummy")).toBe("dummy");
    expect(settingsKeyForExtension("llama")).toBe("llama");
  });
});

describe("computeDrift: clean settings", () => {
  it("produces no findings when every entry does something", () => {
    const findings = computeDrift(
      raw({ modelRouter: { fallback: [] } }),
      { resources: [res({ path: catalog[0].path, displayName: catalog[0].displayName })], settings: state() },
      options(),
    );
    expect(findings).toEqual([]);
  });

  it("an enabled extension with a matching key is not a finding", () => {
    const findings = computeDrift(
      raw({ dummy: { a: 1 } }),
      { resources: [catalog[0]], settings: state() },
      options(),
    );
    expect(findings).toEqual([]);
  });
});

describe("computeDrift: stale entry", () => {
  it("names an override pattern that matches no resource and no file", () => {
    const findings = computeDrift(
      raw(),
      { resources: [catalog[0]], settings: state({ extensions: ["-extensions/gone.ts"] }) },
      options(),
    );
    expect(kinds(findings)).toEqual(["stale"]);
    expect(findings[0].scope).toBe("global");
    expect(findings[0].array).toBe("extensions");
    expect(findings[0].entries).toEqual(["-extensions/gone.ts"]);
    expect(findings[0].possible).toBe(false);
    expect(findings[0].text).toContain('"-extensions/gone.ts"');
    expect(findings[0].text).toContain("global");
  });

  it("a pattern that matches a loaded resource is not stale", () => {
    const findings = computeDrift(
      raw(),
      { resources: [catalog[0]], settings: state({ extensions: ["-extensions/dummy.ts"] }) },
      options(),
    );
    expect(findings).toEqual([]);
  });

  it("a non-matching pattern whose file exists is not stale", () => {
    onDisk.add("/home/u/.pi/agent/extensions/gone.ts");
    try {
      const findings = computeDrift(
        raw(),
        { resources: [catalog[0]], settings: state({ extensions: ["-extensions/gone.ts"] }) },
        options(),
      );
      expect(findings).toEqual([]);
    } finally {
      onDisk.delete("/home/u/.pi/agent/extensions/gone.ts");
    }
  });

  it("names a stale package-filter entry with the package source", () => {
    const settings = state({ packages: [{ source: "/home/u/pkg", extensions: ["-extensions/gone.ts"] }] });
    const findings = computeDrift(raw(), { resources: catalog, settings }, options());
    expect(kinds(findings)).toEqual(["stale"]);
    expect(findings[0].packageSource).toBe("/home/u/pkg");
    expect(findings[0].entries).toEqual(["-extensions/gone.ts"]);
    expect(findings[0].text).toContain('packages "/home/u/pkg"');
    expect(findings[0].text).toContain('"-extensions/gone.ts"');
  });

  it("a package-filter entry that matches a package resource is not stale", () => {
    const settings = state({ packages: [{ source: "/home/u/pkg", extensions: ["-extensions/off.ts"] }] });
    const findings = computeDrift(raw(), { resources: catalog, settings }, options());
    expect(findings).toEqual([]);
  });

  it("a non-matching glob is stale without a disk check", () => {
    const always = { machine, projectTrusted: true, pathExists: (): boolean => true };
    const findings = computeDrift(
      raw(),
      { resources: [catalog[0]], settings: state({ extensions: ["!gone-*.ts"] }) },
      always,
    );
    expect(kinds(findings)).toEqual(["stale"]);
    expect(findings[0].entries).toEqual(["!gone-*.ts"]);
  });

  it("a non-matching pattern in a remote package is stale on the match alone", () => {
    const findings = computeDrift(
      raw(),
      {
        resources: [],
        settings: state({ packages: [{ source: "git:github.com/acme/pkg", extensions: ["-extensions/gone.ts"] }] }),
      },
      { machine, projectTrusted: true, pathExists: (): boolean => true },
    );
    expect(kinds(findings)).toEqual(["stale"]);
    expect(findings[0].packageSource).toBe("git:github.com/acme/pkg");
  });

  it("a plain resource-array entry is not a v1 finding", () => {
    const findings = computeDrift(
      raw(),
      { resources: [catalog[0]], settings: state({ extensions: ["extensions/gone.ts"] }) },
      { machine, projectTrusted: true, pathExists: (): boolean => false },
    );
    expect(findings).toEqual([]);
  });

  it("a project-scope entry is named with the project scope", () => {
    const settings = state({}, { extensions: ["-extensions/gone.ts"] });
    const findings = computeDrift(raw(), { resources: catalog, settings }, options());
    expect(kinds(findings)).toEqual(["stale"]);
    expect(findings[0].scope).toBe("project");
    expect(findings[0].text).toContain("project");
  });
});

describe("computeDrift: conflicting entries", () => {
  it("names a force-include and force-exclude pair in one array", () => {
    const settings = state({ extensions: ["+extensions/dummy.ts", "-extensions/dummy.ts"] });
    const findings = computeDrift(raw(), { resources: [catalog[0]], settings }, options());
    expect(kinds(findings)).toEqual(["conflict"]);
    expect([...findings[0].entries].sort()).toEqual(["+extensions/dummy.ts", "-extensions/dummy.ts"]);
    expect(findings[0].text).toContain("+extensions/dummy.ts");
    expect(findings[0].text).toContain("-extensions/dummy.ts");
  });

  it("the same target with one polarity is not a conflict", () => {
    const settings = state({ extensions: ["+extensions/dummy.ts", "+extensions/dummy.ts"] });
    const findings = computeDrift(raw(), { resources: [catalog[0]], settings }, options());
    expect(findings).toEqual([]);
  });

  it("a conflicting package filter is named with the package source", () => {
    const settings = state({
      packages: [{ source: "/home/u/pkg", extensions: ["+extensions/usage.ts", "-extensions/usage.ts"] }],
    });
    const findings = computeDrift(raw(), { resources: catalog, settings }, options());
    expect(kinds(findings)).toEqual(["conflict"]);
    expect(findings[0].packageSource).toBe("/home/u/pkg");
  });
});

describe("computeDrift: configured while disabled", () => {
  it("reports a disabled extension under its camelCase key as possible", () => {
    const findings = computeDrift(raw({ modelRouter: { fallback: [] } }), { resources: catalog, settings: state() }, options());
    expect(kinds(findings)).toEqual(["configured-disabled"]);
    expect(findings[0].possible).toBe(true);
    expect(findings[0].key).toBe("modelRouter");
    expect(findings[0].scope).toBe("global");
    expect(findings[0].text).toContain('extension "model-router"');
    expect(findings[0].text).toContain('"modelRouter"');
    expect(findings[0].text).toContain("possible");
  });

  it("an index-file extension maps through its folder name", () => {
    const findings = computeDrift(
      raw({ other: {} }),
      { resources: [res({ path: "/home/u/.pi/agent/extensions/other/index.ts", displayName: "other/index.ts", enabled: false, ownEnabled: false })], settings: state() },
      options(),
    );
    expect(kinds(findings)).toEqual(["configured-disabled"]);
    expect(findings[0].key).toBe("other");
  });

  it("a single-word name maps to itself", () => {
    const disabledDummy = res({ path: catalog[0].path, displayName: "dummy", enabled: false, ownEnabled: false });
    const findings = computeDrift(raw({ dummy: {} }), { resources: [disabledDummy], settings: state() }, options());
    expect(kinds(findings)).toEqual(["configured-disabled"]);
    expect(findings[0].key).toBe("dummy");
  });

  it("a key in a mismatched shape is not a finding", () => {
    const findings = computeDrift(raw({ model_router: {}, "model-router": {} }), { resources: catalog, settings: state() }, options());
    expect(findings).toEqual([]);
  });

  it("a key in both documents names both scopes in one finding", () => {
    const findings = computeDrift(raw({ modelRouter: {} }, { modelRouter: {} }), { resources: catalog, settings: state() }, options());
    expect(kinds(findings)).toEqual(["configured-disabled"]);
    expect(findings[0].scope).toBe("global+project");
    expect(findings[0].text).toContain("global and project");
  });

  it("a disabled package extension counts", () => {
    const findings = computeDrift(raw({ off: {} }), { resources: [catalog[4]], settings: state() }, options());
    expect(kinds(findings)).toEqual(["configured-disabled"]);
    expect(findings[0].key).toBe("off");
  });
});

describe("computeDrift: untrusted project", () => {
  it("covers the global scope only: project entries and keys are not reported", () => {
    const findings = computeDrift(
      raw({ goneKey: {} }, { goneKey: {} }),
      {
        resources: catalog,
        settings: state({ extensions: ["-extensions/gone.ts"] }, { extensions: ["-extensions/gone.ts"] }),
      },
      options(false),
    );
    // Only the global stale entry; the project entry and the project-side
    // key are invisible in an untrusted project.
    expect(kinds(findings)).toEqual(["stale"]);
    expect(findings[0].scope).toBe("global");
  });

  it("a key in the project document alone is not reported when untrusted", () => {
    const findings = computeDrift(
      raw({}, { modelRouter: {} }),
      { resources: catalog, settings: state() },
      options(false),
    );
    expect(findings).toEqual([]);
  });
});

describe("computeDrift: deduplication and ordering", () => {
  const settings = state({
    extensions: ["-extensions/gone.ts", "-extensions/gone.ts", "+extensions/dummy.ts", "-extensions/dummy.ts", "+extensions/dummy.ts", "-extensions/dummy.ts"],
    packages: [{ source: "/home/u/pkg", extensions: ["-extensions/gone.ts", "-extensions/gone.ts"] }],
  });

  it("deduplicates repeated entries and conflicting pairs", () => {
    const findings = computeDrift(raw({ modelRouter: {} }), { resources: catalog, settings }, options());
    // One stale resource-array entry, one stale package-filter entry, one
    // conflict, one soft finding.
    expect(findings.length).toBe(4);
    expect(findings.filter((f) => f.kind === "stale" && f.array === "extensions" && !f.packageSource).length).toBe(1);
    expect(findings.filter((f) => f.kind === "stale" && f.packageSource).length).toBe(1);
    expect(findings.filter((f) => f.kind === "conflict").length).toBe(1);
    expect(findings.filter((f) => f.kind === "configured-disabled").length).toBe(1);
  });

  it("sorts by class, scope, then text", () => {
    const findings = computeDrift(raw({ modelRouter: {} }), { resources: catalog, settings }, options());
    const byKind = [findings[0].kind, findings[1].kind, findings[2].kind, findings[3].kind];
    expect(byKind[0]).toBe("stale");
    expect(byKind[1]).toBe("stale");
    expect(byKind[2]).toBe("conflict");
    expect(byKind[3]).toBe("configured-disabled");
  });

  it("is deterministic across runs", () => {
    const a = computeDrift(raw({ modelRouter: {} }), { resources: catalog, settings }, options());
    const b = computeDrift(raw({ modelRouter: {} }), { resources: catalog, settings }, options());
    expect(a).toEqual(b);
  });
});

describe("renderDriftSection and driftNoticeText", () => {
  it("renders nothing for clean settings", () => {
    expect(renderDriftSection([])).toBe("");
  });

  it("renders a header and one line per finding", () => {
    const findings = computeDrift(raw({ modelRouter: {} }), { resources: catalog, settings: state({ extensions: ["-extensions/gone.ts"] }) }, options());
    const section = renderDriftSection(findings);
    expect(section).toContain("drift (2)");
    const lines = section.split("\n");
    expect(lines[0]).toBe("drift (2)");
    expect(lines.length).toBe(3);
    for (const line of lines.slice(1)) {
      expect(line.startsWith("  ")).toBe(true);
    }
  });

  it("the notice reports the count and points at /resources", () => {
    expect(driftNoticeText(3)).toBe("resource-toggle: 3 settings drift findings at session start; run /resources to see them");
    expect(driftNoticeText(1)).toBe("resource-toggle: 1 settings drift finding at session start; run /resources to see them");
  });
});
