/**
 * Resource description derivation (ADR 0030).
 *
 * Derives the one-line Resource description of a resource from its source
 * file, at list time and read-only:
 *
 *   - skill: the SKILL.md frontmatter `description`.
 *   - prompt template: the frontmatter `description`, falling back to the
 *     first non-empty line of the body - the rule pi itself applies.
 *   - extension: the leading block comment of the entry file. A BOM or
 *     shebang line may precede it; `/*` and `**` both count. Comment
 *     markers and leading stars are stripped, all whitespace runs collapse
 *     to single spaces, uncapped at the source.
 *   - theme: none.
 *
 * The resolver keeps the full collapsed text; every display surface caps
 * what it prints. Unreadable files and missing fields get no description,
 * never a wrong one.
 */
import { readFileSync } from "node:fs";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { ResourceType } from "./types.ts";

function readSource(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Collapse every whitespace run to a single space and trim. */
const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();

const frontmatterDescription = (frontmatter: Record<string, unknown> | undefined): string | undefined => {
  const description = frontmatter?.description;
  if (typeof description === "string" && description.trim()) return collapse(description);
  return undefined;
};

/** The skill rule: the frontmatter `description`, nothing else. */
function skillDescription(content: string): string | undefined {
  try {
    const { frontmatter } = parseFrontmatter(content);
    return frontmatterDescription(frontmatter);
  } catch {
    // Unreadable or malformed frontmatter gets no description.
    return undefined;
  }
}

/** The prompt rule: the frontmatter `description`, else the first non-empty line of the body. */
function promptDescription(content: string): string | undefined {
  try {
    const { frontmatter, body } = parseFrontmatter(content);
    const fromFrontmatter = frontmatterDescription(frontmatter);
    if (fromFrontmatter) return fromFrontmatter;
    const firstLine = body.split("\n").find((line) => line.trim());
    return firstLine ? collapse(firstLine) : undefined;
  } catch {
    // Malformed frontmatter: fall through to the first non-empty line of the
    // body, skipping a frontmatter block that could not be parsed.
    const withoutBlock = content.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
    const firstLine = withoutBlock.split("\n").find((line) => line.trim());
    return firstLine ? collapse(firstLine) : undefined;
  }
}

/** The extension rule: the leading block comment of the entry file. */
function extensionDescription(content: string): string | undefined {
  let text = content;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // a BOM may precede
  const shebang = text.match(/^#![^\r\n]*(?:\r\n|\n|\r|$)/);
  if (shebang) text = text.slice(shebang[0].length); // a shebang line may precede
  const comment = text.match(/^\/\*[\s\S]*?\*\//);
  if (!comment) return undefined; // no comment at the start of the file: no description
  const inner = comment[0].slice(2, -2); // strip the /* and */ markers
  const lines = inner.split("\n").map((line) => line.replace(/^[ \t]*\*+[ \t]?/, ""));
  return collapse(lines.join(" ")) || undefined;
}

/**
 * The Resource description of one resource, read from its source file.
 * `undefined` for themes and for files that carry no description.
 */
export function resourceDescription(type: ResourceType, path: string): string | undefined {
  if (type === "themes") return undefined;
  const content = readSource(path);
  if (content === undefined) return undefined;
  if (type === "skills") return skillDescription(content);
  if (type === "prompts") return promptDescription(content);
  return extensionDescription(content);
}
