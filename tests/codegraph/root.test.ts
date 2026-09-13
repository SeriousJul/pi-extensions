/**
 * Root module: the path rule (spec 0009) and named-root resolution.
 *
 * Fast unit tests: no index build, no library. Plain temporary directories
 * stand in for project roots, and the nearest-initialized-ancestor lookup
 * and the index check are injected as functions.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CodegraphUnavailable,
  expandPathArg,
  namedRootFile,
  resolveNamedRoot,
} from "../../extensions/codegraph/root";

let base: string;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-root-"));
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

function mkdir(p: string): string {
  fs.mkdirSync(p, { recursive: true });
  return fs.realpathSync(p);
}

describe("expandPathArg (the path rule)", () => {
  it("keeps an absolute path as it is", () => {
    expect(expandPathArg("/a/b", base)).toBe("/a/b");
  });

  it("expands a bare ~ to the home directory", () => {
    expect(expandPathArg("~", base)).toBe(os.homedir());
  });

  it("expands ~/x against the home directory", () => {
    expect(expandPathArg("~/proj/src", base)).toBe(
      path.join(os.homedir(), "proj/src"),
    );
  });

  it("resolves every other form against the base directory", () => {
    expect(expandPathArg("rel/x", base)).toBe(path.resolve(base, "rel/x"));
    expect(expandPathArg("../sibling", base)).toBe(
      path.resolve(base, "../sibling"),
    );
  });
});

describe("namedRootFile (the file rule of a named root)", () => {
  let root: string;

  beforeEach(() => {
    root = mkdir(path.join(base, "root"));
  });

  it("expresses a relative file argument against the named root", () => {
    expect(namedRootFile(root, "src/x.ts")).toBe("src/x.ts");
  });

  it("expresses an absolute file argument against the named root", () => {
    expect(namedRootFile(root, path.join(root, "src/y.ts"))).toBe(
      "src/y.ts",
    );
  });

  it("is '.' when the argument names the root itself", () => {
    expect(namedRootFile(root, ".")).toBe(".");
  });

  it("refuses a file that escapes the named root, naming both paths", () => {
    const outside = path.join(base, "other.ts");
    expect(() => namedRootFile(root, "../other.ts")).toThrow(
      CodegraphUnavailable,
    );
    try {
      namedRootFile(root, "../other.ts");
    } catch (err) {
      expect(err).toBeInstanceOf(CodegraphUnavailable);
      expect((err as CodegraphUnavailable).reason).toBe(
        `file ${outside} is outside the named project root (${root})`,
      );
      expect((err as CodegraphUnavailable).noLedger).toBe(true);
    }
  });

  it("refuses an absolute file argument outside the named root", () => {
    expect(() => namedRootFile(root, "/etc/hosts")).toThrow(
      CodegraphUnavailable,
    );
  });
});

describe("resolveNamedRoot (a call that named its own root)", () => {
  function makeRepo(name: string): string {
    const root = mkdir(path.join(base, name));
    fs.writeFileSync(path.join(root, "package.json"), "{}");
    return root;
  }

  it("serves a named directory that has an index without creating one", () => {
    const root = makeRepo("dep");
    const resolved = resolveNamedRoot(root, undefined, base, {
      findNearest: (start: string) =>
        start === root || start.startsWith(root + path.sep) ? root : null,
    });
    expect(resolved).toMatchObject({
      root,
      needsCreate: false,
      isMainCheckout: false,
      named: true,
    });
  });

  it("marks a named directory without an index for creation", () => {
    const root = makeRepo("dep");
    const resolved = resolveNamedRoot(root, undefined, base, {
      findNearest: () => null,
    });
    expect(resolved.root).toBe(root);
    expect(resolved.needsCreate).toBe(true);
  });

  it("fails with the exact message and the fetch hint for a missing directory", () => {
    const missing = path.join(base, "absent");
    try {
      resolveNamedRoot(missing, undefined, base, {
        fetchHint: () =>
          " - the source is not cached; ask the user to run: opensrc fetch acme/pkg",
      });
      expect.unreachable("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CodegraphUnavailable);
      expect((err as CodegraphUnavailable).reason).toBe(
        `no such directory (${missing}) - the source is not cached; ` +
          "ask the user to run: opensrc fetch acme/pkg",
      );
      expect((err as CodegraphUnavailable).noLedger).toBe(true);
    }
  });

  it("resolves a named path that is a file to its directory", () => {
    const root = makeRepo("dep");
    const file = path.join(root, "README.md");
    fs.writeFileSync(file, "readme");
    const resolved = resolveNamedRoot(file, undefined, base, {
      findNearest: (start: string) =>
        start === root || start.startsWith(root + path.sep) ? root : null,
    });
    expect(resolved.root).toBe(root);
    expect(resolved.needsCreate).toBe(false);
  });

  it("snaps a named directory inside a cache entry to the entry's tree", () => {
    const entry = mkdir(path.join(base, "cache", "pkg", "1.2.3"));
    const nested = mkdir(path.join(entry, "src"));
    const resolved = resolveNamedRoot(nested, undefined, base, {
      snap: (r) =>
        r === entry || r.startsWith(entry + path.sep) ? entry : undefined,
      hasIndex: (r) => r === entry,
    });
    expect(resolved.root).toBe(entry);
    expect(resolved.needsCreate).toBe(false);
  });

  it("applies the file argument to the snapped root", () => {
    const entry = mkdir(path.join(base, "cache", "pkg", "1.2.3"));
    const nested = mkdir(path.join(entry, "src"));
    const resolved = resolveNamedRoot(nested, "lib.ts", base, {
      snap: (r) =>
        r === entry || r.startsWith(entry + path.sep) ? entry : undefined,
      hasIndex: () => false,
    });
    expect(resolved.root).toBe(entry);
    expect(resolved.file).toBe("lib.ts");
    expect(resolved.named).toBe(true);
  });

  it("honors a named directory outside any entry through the normal root policy", () => {
    const parent = mkdir(path.join(base, "repo"));
    fs.writeFileSync(path.join(parent, "package.json"), "{}");
    const sub = mkdir(path.join(parent, "packages", "one"));
    const resolved = resolveNamedRoot(sub, undefined, base, {
      findNearest: (start: string) =>
        start === sub || start.startsWith(sub + path.sep) ? parent : null,
      hasIndex: () => false,
    });
    // The nearest initialized ancestor serves the call: the repository.
    expect(resolved.root).toBe(parent);
    expect(resolved.needsCreate).toBe(false);
    expect(resolved.named).toBe(true);
  });

  it("runs the manifest rule for a named directory with no index above it", () => {
    const repo = mkdir(path.join(base, "repo"));
    fs.writeFileSync(path.join(repo, "package.json"), "{}");
    const resolved = resolveNamedRoot(repo, undefined, base, {
      hasIndex: () => false,
    });
    expect(resolved.root).toBe(repo);
    expect(resolved.needsCreate).toBe(true);
  });

  it("applies the path rule to the projectRoot argument", () => {
    makeRepo("dep");
    const root = fs.realpathSync(path.join(base, "dep"));
    const resolved = resolveNamedRoot("./dep", undefined, base, {
      findNearest: (start: string) =>
        start === root || start.startsWith(root + path.sep) ? root : null,
    });
    expect(resolved.root).toBe(root);
  });

  it("refuses a file argument that escapes the named root", () => {
    const root = makeRepo("dep");
    const other = mkdir(path.join(base, "other"));
    const target = path.join(other, "f.ts");
    fs.writeFileSync(target, "x");
    try {
      resolveNamedRoot(root, target, base, {
        findNearest: () => null,
      });
      expect.unreachable("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CodegraphUnavailable);
      expect((err as CodegraphUnavailable).noLedger).toBe(true);
    }
  });
});
