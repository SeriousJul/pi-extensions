/**
 * resource-toggle: enable and disable extensions, skills, prompt
 * templates, and themes from inside a running session.
 *
 * - /resources opens the interactive list in TUI mode (text table in the
 *   headless modes).
 * - /enable, /disable, /inherit change the state of one named resource; a
 *   scope flag selects global (default) or project mode, inherit is project
 *   mode only.
 * - The resource_toggle tool lets the agent list resources and apply
 *   changes on request; with no arguments it opens the interactive list.
 *
 * State lives in pi's native settings override patterns, the same files and
 * format `pi config` uses (ADR 0012), so the two tools are interchangeable.
 * Every change flushes the settings and then reloads the session, so the
 * effect is immediate and survives a restart.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { machineContextFor, resolveResources } from "./lib/resolver.ts";
import { matchResource } from "./lib/matcher.ts";
import { writeSettings } from "./lib/writer.ts";
import { projectOverrideState, resourceLabel, transition } from "./lib/state-machine.ts";
import { globalViewRows, projectViewRows, renderResourceTable, shortPath } from "./lib/table.ts";
import type {
  MachineContext,
  OverrideState,
  ResolvedResources,
  ResourceInfo,
  ResourceRef,
  SettingsState,
  ToggleOp,
  WriteMode,
} from "./lib/types.ts";
import { createResourceToggleTui } from "./tui.ts";

/** The loaded path of this extension; disabling it is refused (self-guard). */
const SELF_PATH = fileURLToPath(import.meta.url);

const RELOAD_NOTE =
  "A reload rebinds every extension, so the in-session state of other extensions resets.";

interface SessionState {
  cwd: string;
  projectTrusted: boolean;
}

export default function (pi: ExtensionAPI): void {
  const state: SessionState = { cwd: process.cwd(), projectTrusted: false };
  pi.on("session_start", (_event, ctx) => {
    state.cwd = ctx.cwd;
    state.projectTrusted = ctx.isProjectTrusted();
  });

  const machine = (): MachineContext => machineContextFor(state.cwd, getAgentDir());

  const isSelf = (path: string): boolean => {
    const self = safeRealpath(SELF_PATH);
    const other = safeRealpath(path);
    if (self && other) return self === other;
    return SELF_PATH === path;
  };

  /** Report to the user in whatever mode the session runs in. */
  const report = (ctx: ExtensionCommandContext, text: string, ok: boolean): void => {
    if (ctx.hasUI) {
      ctx.ui.notify(text, ok ? "info" : "warning");
    } else if (ok) {
      console.log(text);
    } else {
      console.error(text);
    }
  };

  /**
   * The shared pipeline: resolve, match, self-guard, transition, write.
   * Returns a human-readable report. The caller triggers the reload.
   */
  async function applyToggle(
    op: ToggleOp,
    name: string,
  ): Promise<{ ok: boolean; text: string; resource?: ResourceInfo; needsReload: boolean }> {
    const resolved: ResolvedResources = await resolveResources({
      cwd: state.cwd,
      agentDir: getAgentDir(),
      projectTrusted: state.projectTrusted,
      selfPath: SELF_PATH,
    });
    const match = matchResource(resolved.resources, name);
    if (match.status === "none") {
      return { ok: false, text: `No resource matches "${name}".`, needsReload: false };
    }
    if (match.status === "ambiguous") {
      const list = match.candidates
        .map((c) => `  ${c.displayName}  (${resourceLabel(c.type)}, ${c.scope === "user" ? "global" : "project"}, ${shortPath(c.path)})`)
        .join("\n");
      return { ok: false, text: `Ambiguous name "${name}". Candidates:\n${list}`, needsReload: false };
    }
    const resource = match.resource;
    if (op.op !== "enable" && isSelf(resource.path)) {
      return {
        ok: false,
        text: `Refused: resource-toggle will not ${op.op} itself; that would remove the toggle commands.`,
        needsReload: false,
      };
    }
    const ref: ResourceRef = { type: resource.type, path: resource.path, scope: resource.scope, baseDir: resource.baseDir };
    const next: SettingsState = transition(resolved.settings, ref, op, machine());
    const outcome = await writeSettings(
      { cwd: state.cwd, agentDir: getAgentDir(), projectTrusted: state.projectTrusted },
      resolved.settings,
      next,
    );
    if (!outcome.ok) {
      return { ok: false, text: outcome.error ?? "Settings write failed.", needsReload: false };
    }
    const verb = op.op === "enable" ? "Enabled" : op.op === "inherit" ? "Cleared the project override of" : "Disabled";
    const scopeText = op.op === "inherit" ? "project" : op.mode;
    const text = `${verb} ${resourceLabel(resource.type)} "${resource.displayName}" in ${scopeText} scope. Settings written; the session will reload. ${RELOAD_NOTE}`;
    return { ok: true, text, resource, needsReload: true };
  }

  /** Parse `/disable name --project` style arguments. */
  function parseArgs(args: string): { name?: string; mode?: WriteMode; error?: string } {
    const tokens = args.trim().split(/\s+/).filter(Boolean);
    let name: string | undefined;
    let mode: WriteMode | undefined;
    for (const token of tokens) {
      if (token === "--global") mode = "global";
      else if (token === "--project") mode = "project";
      else if (token.startsWith("-")) return { error: `Unknown flag "${token}". Use --global or --project.` };
      else if (!name) name = token;
      else return { error: `Expected one resource name, got "${name}" and "${token}".` };
    }
    return { name, mode };
  }

  const listText = (resolved: ResolvedResources, view: WriteMode): string => {
    const machineCtx = machine();
    if (view === "global") {
      return renderResourceTable(globalViewRows(resolved.resources));
    }
    const overrides = new Map<ResourceInfo, OverrideState>();
    for (const resource of resolved.resources) {
      const ref: ResourceRef = { type: resource.type, path: resource.path, scope: resource.scope, baseDir: resource.baseDir };
      overrides.set(resource, projectOverrideState(resolved.settings, ref, machineCtx));
    }
    return renderResourceTable(projectViewRows(resolved.resources, overrides));
  };

  pi.registerCommand("resources", {
    description:
      "List every loadable resource (extensions, skills, prompts, themes) with its state; interactive list with toggles in TUI mode",
    async handler(args, ctx) {
      const resolved = await resolveResources({
        cwd: ctx.cwd,
        agentDir: getAgentDir(),
        projectTrusted: ctx.isProjectTrusted(),
        selfPath: SELF_PATH,
      });
      if (ctx.hasUI && ctx.mode === "tui") {
        let changed = false;
        await ctx.ui.custom((tui, theme, _keybindings, done) =>
          createResourceToggleTui({
            tui,
            theme,
            resources: resolved.resources,
            settings: resolved.settings,
            machine: machine(),
            projectTrusted: ctx.isProjectTrusted(),
            apply: (prev, next) =>
              writeSettings({ cwd: ctx.cwd, agentDir: getAgentDir(), projectTrusted: ctx.isProjectTrusted() }, prev, next),
            viewport: () => Math.max(5, tui.terminal.rows - 8),
            close: (didChange) => {
              changed = didChange;
              done(undefined);
            },
          }),
        );
        if (changed) {
          report(ctx, `Changes written; reloading. ${RELOAD_NOTE}`, true);
          await ctx.reload();
        }
        return;
      }
      const view: WriteMode = args.trim() === "--project" ? "project" : "global";
      const text = `resources (${view} view)\n${listText(resolved, view)}`;
      if (ctx.hasUI) {
        ctx.ui.notify(text, "info");
      } else {
        console.log(text);
      }
    },
  });

  const registerStateCommand = (op: "enable" | "disable" | "inherit", description: string): void => {
    pi.registerCommand(op, {
      description,
      async handler(args, ctx) {
        const parsed = parseArgs(args);
        if (parsed.error) {
          report(ctx, parsed.error, false);
          return;
        }
        if (!parsed.name) {
          report(ctx, `Usage: /${op} <name> [--global | --project]`, false);
          return;
        }
        let operation: ToggleOp;
        if (op === "inherit") {
          if (parsed.mode === "global") {
            report(ctx, "inherit is project mode only; it has no --global flag.", false);
            return;
          }
          operation = { op: "inherit" };
        } else {
          operation = { op, mode: parsed.mode ?? "global" };
        }
        const result = await applyToggle(operation, parsed.name);
        report(ctx, result.text, result.ok);
        if (result.ok) {
          await ctx.reload();
        }
      },
    });
  };

  registerStateCommand("enable", "Enable a resource by name: /enable <name> [--global | --project]");
  registerStateCommand("disable", "Disable a resource by name: /disable <name> [--global | --project]");
  registerStateCommand("inherit", "Clear the project override of a resource so it inherits the global state: /inherit <name>");

  // The tool path cannot trigger a reload itself, so the reload rides on
  // this internal command, queued as a follow-up.
  pi.registerCommand("resource-reload", {
    description: "Reload extensions, skills, prompts, and themes (internal to resource-toggle)",
    async handler(_args, ctx) {
      await ctx.reload();
    },
  });

  pi.registerTool({
    name: "resource_toggle",
    label: "Resource Toggle",
    description:
      "List or change the state of pi resources (extensions, skills, prompt templates, themes) in the running session. With no arguments it opens the interactive resource list for the user. With action 'list' it returns a text table. With 'enable', 'disable', or 'inherit' plus a name it applies the change, writes the settings, and queues the session reload.",
    promptSnippet: "Enable or disable extensions, skills, prompt templates, and themes in the session",
    parameters: Type.Object({
      action: Type.Optional(
        Type.Union([Type.Literal("list"), Type.Literal("enable"), Type.Literal("disable"), Type.Literal("inherit")]),
      ),
      name: Type.Optional(Type.String({ description: "Display name, unique name prefix, or path fragment of the resource" })),
      scope: Type.Optional(
        Type.Union([Type.Literal("global"), Type.Literal("project")], {
          description: "Write mode. Default global; inherit is project mode only.",
        }),
      ),
    }),
    promptGuidelines: [
      "Use resource_toggle when the user asks which extensions, skills, prompt templates, or themes are active, or asks to enable, disable, or re-inherit one.",
    ],
    async execute(_toolCallId, params) {
      if (params.action === undefined && (params.name === undefined || params.name === "")) {
        pi.sendUserMessage("/resources", { deliverAs: "followUp" });
        return {
          content: [{ type: "text", text: "Opened the interactive resource list in the terminal for the user." }],
          details: {},
        };
      }
      if (params.action === undefined) {
        return {
          content: [{ type: "text", text: "Provide an action: list, enable, disable, or inherit." }],
          details: {},
        };
      }
      if (params.action === "list") {
        const resolved = await resolveResources({
          cwd: state.cwd,
          agentDir: getAgentDir(),
          projectTrusted: state.projectTrusted,
        selfPath: SELF_PATH,
        });
        const global = listText(resolved, "global");
        const project = state.projectTrusted ? `\nresources (project view)\n${listText(resolved, "project")}` : "";
        return {
          content: [{ type: "text", text: `resources (global view)\n${global}${project}` }],
          details: {},
        };
      }
      if (params.name === undefined || params.name === "") {
        return { content: [{ type: "text", text: `action ${params.action} requires a name.` }], details: {} };
      }
      if (params.action === "inherit" && params.scope === "global") {
        return { content: [{ type: "text", text: "inherit is project mode only; it has no global scope." }], details: {} };
      }
      const operation: ToggleOp =
        params.action === "inherit"
          ? { op: "inherit" }
          : { op: params.action, mode: params.scope ?? "global" };
      const result = await applyToggle(operation, params.name);
      if (!result.ok) {
        return { content: [{ type: "text", text: result.text }], details: {} };
      }
      pi.sendUserMessage("/resource-reload", { deliverAs: "followUp" });
      const text = `${result.text} A session reload is queued; when it runs, the ${result.resource ? resourceLabel(result.resource.type) : "resource"} ${
        operation.op === "enable" ? "rejoins" : operation.op === "inherit" ? "returns to the global state" : "stops contributing tools, commands, and event behavior"
      } the live session.`;
      return { content: [{ type: "text", text }], details: {} };
    },
  });
}

function safeRealpath(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}
