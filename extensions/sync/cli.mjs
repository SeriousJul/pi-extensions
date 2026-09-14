#!/usr/bin/env node
/**
 * pi-sync bin wrapper. The extension modules are TypeScript loaded through
 * jiti (the same loader pi itself uses), so there is no build step.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { createJiti } = await import("jiti");
const here = dirname(fileURLToPath(import.meta.url));
const cliPath = join(here, "cli.ts");
const jiti = createJiti(cliPath);
const { main } = await jiti.import(cliPath);
process.exitCode = await main(process.argv.slice(2));
