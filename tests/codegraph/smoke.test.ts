/**
 * Plain-Node smoke test wrapper.
 *
 * The extension must load and answer under plain Node with pi's jiti
 * loader, because that is how pi runs it in npm install mode (and tsx
 * from source) - and because the in-process vitest suite runs under
 * vite-node, whose CJS/ESM interop masks the exact class of breakage that
 * plain Node exposes. See smoke/smoke-node.mjs for the actual run.
 *
 * Skipped when no node binary is on the PATH (e.g. a bare bun checkout).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function findNode(): string | null {
  try {
    execFileSync("node", ["--version"], { stdio: "ignore" });
    return "node";
  } catch {
    return null;
  }
}

const node = findNode();

if (node) {
  describe("plain node smoke test (pi jiti load path)", () => {
    it(
      "loads the extension through jiti under plain node and runs a tool handler",
      () => {
        const script = fileURLToPath(
          new URL("smoke/smoke-node.mjs", import.meta.url),
        );
        const res = spawnSync(node, [script], {
          encoding: "utf-8",
          timeout: 240_000,
        });
        if (res.status !== 0) {
          throw new Error(
            `smoke exited with ${res.status}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`,
          );
        }
        expect(res.stdout).toContain("SMOKE OK");
      },
      240_000,
    );
  });
}
