/**
 * The name matcher.
 *
 * Display name first (file base name for an extension, prompt template, or
 * theme; frontmatter name for a skill), then path substring. A match must be
 * unique; otherwise the candidates are reported so a typo cannot hit the
 * wrong resource.
 */
import type { ResourceInfo } from "./types.ts";

export type NameMatch =
  | { status: "ok"; resource: ResourceInfo }
  | { status: "ambiguous"; candidates: ResourceInfo[] }
  | { status: "none" };

/**
 * One argument-completion item of a state command. `value` is what an
 * accepted item inserts: the display name.
 */
export interface CompletionItem {
  value: string;
  label: string;
  description?: string;
}

/**
 * The argument-completion items for the state commands: display names,
 * matched the same ways the named command resolves a name - a
 * case-insensitive name prefix or a path fragment - each carrying the
 * resource's Resource description. An empty prefix yields every resource.
 */
export function completionItems(resources: readonly ResourceInfo[], prefix: string): CompletionItem[] {
  const query = prefix.trim().toLowerCase();
  return resources
    .filter(
      (r) =>
        query === "" ||
        r.displayName.toLowerCase().startsWith(query) ||
        r.path.toLowerCase().includes(query),
    )
    .map((r) => ({ value: r.displayName, label: r.displayName, description: r.description }));
}

export function matchResource(resources: readonly ResourceInfo[], name: string): NameMatch {
  const query = name.trim().toLowerCase();
  if (!query) return { status: "none" };

  const exact = resources.filter((r) => r.displayName.toLowerCase() === query);
  if (exact.length === 1) return { status: "ok", resource: exact[0] };
  if (exact.length > 1) return { status: "ambiguous", candidates: exact };

  const prefix = resources.filter((r) => r.displayName.toLowerCase().startsWith(query));
  if (prefix.length === 1) return { status: "ok", resource: prefix[0] };
  if (prefix.length > 1) return { status: "ambiguous", candidates: prefix };

  const pathSub = resources.filter((r) => r.path.toLowerCase().includes(query));
  if (pathSub.length === 1) return { status: "ok", resource: pathSub[0] };
  if (pathSub.length > 1) return { status: "ambiguous", candidates: pathSub };

  return { status: "none" };
}
