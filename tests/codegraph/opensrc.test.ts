/**
 * The dependency-source module (spec 0009): labels, snapping, the path-form
 * label, the cache home, the trusted roots from the environment, and the
 * fetch hint.
 *
 * Every manifest read is injected, so no test shells out. The memo is
 * observed through its documented behavior: a re-read only when the
 * manifest's mtime moves, and a failed read keeps the last good entries.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  cacheHome,
  createOpenSrc,
  pathLabel,
  trustedRootsFromEnv,
} from "../../extensions/codegraph/opensrc";

let home: string;

beforeEach(() => {
  home = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-opensrc-")),
  );
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

/** Create a directory under the home and return its real path. */
function entry(rel: string): string {
  const p = path.join(home, rel);
  fs.mkdirSync(p, { recursive: true });
  return fs.realpathSync(p);
}

describe("the project label", () => {
  it("labels an exact cache entry match with name and version", () => {
    const e = entry("packages/react/18.2.0");
    const o = createOpenSrc(home, {
      list: () => ({
        packages: [
          { name: "react", version: "18.2.0", path: "packages/react/18.2.0" },
        ],
      }),
    });
    expect(o.labelFor(e)).toBe("react @18.2.0");
  });

  it("matches the longest prefix inside a monorepo entry", () => {
    const repo = entry("repos/github.com/x/opentui/0.5.9");
    const nested = entry("repos/github.com/x/opentui/0.5.9/packages/react");
    const o = createOpenSrc(home, {
      list: () => ({
        repos: [
          {
            name: "opentui",
            version: "0.5.9",
            path: "repos/github.com/x/opentui/0.5.9",
          },
          {
            name: "@x/opentui-react",
            version: "0.5.9",
            path: "repos/github.com/x/opentui/0.5.9/packages/react",
          },
        ],
      }),
    });
    // The sub-directory entry wins for its own tree and its descendants.
    expect(o.labelFor(nested)).toBe("@x/opentui-react @0.5.9");
    expect(o.cacheRootFor(path.join(nested, "src"))).toBe(nested);
    // The repository root still labels the repository.
    expect(o.labelFor(repo)).toBe("opentui @0.5.9");
  });

  it("shows every name on one path", () => {
    const e = entry("repos/github.com/emilk/egui/0.36.1");
    const o = createOpenSrc(home, {
      list: () => ({
        packages: [
          {
            name: "egui",
            version: "0.36.1",
            path: "repos/github.com/emilk/egui/0.36.1",
          },
          {
            name: "eframe",
            version: "0.36.1",
            path: "repos/github.com/emilk/egui/0.36.1",
          },
        ],
      }),
    });
    expect(o.labelFor(e)).toBe("egui, eframe @0.36.1");
  });

  it("reports no label for a root above every entry", () => {
    entry("packages/react/18.2.0");
    const o = createOpenSrc(home, {
      list: () => ({
        packages: [
          { name: "react", version: "18.2.0", path: "packages/react/18.2.0" },
        ],
      }),
    });
    expect(o.labelFor(home)).toBeUndefined();
    expect(o.cacheRootFor(home)).toBeUndefined();
  });

  it("re-reads the manifest when its mtime moves and not before", () => {
    const e = entry("packages/a/1.0.0");
    let calls = 0;
    let mtime = 1;
    let version = "1.0.0";
    const o = createOpenSrc(home, {
      list: () => {
        calls += 1;
        return {
          packages: [{ name: "a", version, path: "packages/a/1.0.0" }],
        };
      },
      manifestStat: () => ({ mtimeMs: mtime }),
    });
    expect(o.labelFor(e)).toBe("a @1.0.0");
    expect(o.labelFor(e)).toBe("a @1.0.0");
    expect(calls).toBe(1); // memoized
    version = "2.0.0";
    mtime = 2; // the manifest changed on disk
    expect(o.labelFor(e)).toBe("a @2.0.0");
    expect(calls).toBe(2);
  });

  it("costs one read while the manifest is absent and the reader works", () => {
    const e = entry("packages/a/1.0.0");
    let calls = 0;
    const o = createOpenSrc(home, {
      list: () => {
        calls += 1;
        return {
          packages: [{ name: "a", version: "1.0.0", path: "packages/a/1.0.0" }],
        };
      },
      manifestStat: () => undefined, // no sources.json on disk
    });
    expect(o.labelFor(e)).toBe("a @1.0.0");
    expect(o.labelFor(e)).toBe("a @1.0.0");
    expect(calls).toBe(1); // the absent manifest is a stable state
  });

  it("degrades to no label when the reader is missing or fails", () => {
    const e = entry("packages/a/1.0.0");
    const absent = createOpenSrc(home, {
      list: () => {
        throw new Error("no opensrc on this machine");
      },
    });
    expect(absent.labelFor(e)).toBeUndefined();

    let broken = false;
    const flaky = createOpenSrc(home, {
      list: () => {
        if (broken) throw new Error("the cli died mid-session");
        return {
          packages: [{ name: "a", version: "1.0.0", path: "packages/a/1.0.0" }],
        };
      },
      manifestStat: () => ({ mtimeMs: broken ? 2 : 1 }),
    });
    expect(flaky.labelFor(e)).toBe("a @1.0.0");
    broken = true; // the manifest moved and the read now fails
    expect(flaky.labelFor(e)).toBe("a @1.0.0"); // last good entries win
  });
});

describe("the fetch name", () => {
  it("names a manifest entry by its first name", () => {
    const o = createOpenSrc(home, {
      list: () => ({
        packages: [
          { name: "react", version: "18.2.0", path: "packages/react/18.2.0" },
        ],
      }),
    });
    const e = entry("packages/react/18.2.0");
    expect(o.fetchNameFor(e)).toBe("react");
  });

  it("derives a best-effort name for a path under the home with a version leaf", () => {
    const o = createOpenSrc(home, { list: () => ({}) });
    expect(
      o.fetchNameFor(path.join(home, "packages", "react", "18.2.0")),
    ).toBe("react");
    expect(
      o.fetchNameFor(
        path.join(home, "repos", "github.com", "emilk", "egui", "0.36.1"),
      ),
    ).toBe("egui");
  });

  it("names a missing path under a symlinked home", () => {
    entry("packages/a/1.0.0");
    const linkDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-opensrc-link-")),
    );
    fs.symlinkSync(home, path.join(linkDir, "home"));
    try {
      const o = createOpenSrc(home, {
        list: () => ({
          packages: [
            { name: "a", version: "1.0.0", path: "packages/a/1.0.0" },
          ],
        }),
      });
      const missing = path.join(
        linkDir,
        "home",
        "packages",
        "a",
        "1.0.0",
        "src",
      );
      expect(o.fetchNameFor(missing)).toBe("a");
    } finally {
      fs.rmSync(linkDir, { recursive: true, force: true });
    }
  });

  it("names nothing for a path outside the home", () => {
    const o = createOpenSrc(home, { list: () => ({}) });
    expect(o.fetchNameFor("/elsewhere/dep")).toBeUndefined();
  });
});

describe("the path-form label", () => {
  it("takes the last two path segments", () => {
    expect(
      pathLabel("/home/u/.opensrc/repos/github.com/emilk/egui/0.36.1"),
    ).toBe("egui/0.36.1");
  });

  it("takes the basename alone when there are fewer", () => {
    expect(pathLabel("/opt/mydep")).toBe("mydep");
    expect(pathLabel("/mydep")).toBe("mydep");
  });
});

describe("the cache home and the trusted roots", () => {
  it("respects an explicit OPENSRC_HOME and reports a missing one as absent", () => {
    const explicit = entry("cache");
    expect(cacheHome({ OPENSRC_HOME: explicit })).toBe(explicit);
    expect(cacheHome({ OPENSRC_HOME: "/no/such/dir" })).toBeUndefined();
  });

  it("builds the trusted roots from the home and the PATH-style list", () => {
    const cache = entry("cache");
    const extra = entry("extra");
    const roots = trustedRootsFromEnv({
      OPENSRC_HOME: cache,
      CODEGRAPH_PI_TRUSTED_ROOTS: `${extra}:/no/such/dir:${extra}`,
    });
    expect(roots).toEqual([
      { root: cache, origin: "OPENSRC_HOME" },
      { root: extra, origin: "CODEGRAPH_PI_TRUSTED_ROOTS" },
    ]);
  });

  it("lists no roots when the environment names none", () => {
    // An explicit home that points nowhere counts as "no cache".
    expect(
      trustedRootsFromEnv({ OPENSRC_HOME: "/no/such/cache" }),
    ).toEqual([]);
  });
});
