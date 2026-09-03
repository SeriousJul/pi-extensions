/**
 * Rendering of query results into the text tool outputs.
 */
import "./env";
import type {
  CodeGraph,
  Edge,
  Node,
  NodeKind,
  SearchResult,
  Subgraph,
} from "@colbymchenry/codegraph";
import fs from "node:fs";
import path from "node:path";
import { CodegraphUnavailable } from "./root";

const MAX_BODY_LINES = 400;
const MAX_EXPLORE_LINES_PER_FILE = 200;
const MAX_CALL_PATHS = 40;
const DEFAULT_VIEW_LIMIT = 2000;

export interface CtxLike {
  /** Absolute working directory the call was made from. */
  cwd: string;
}

export function unavailableText(reason: string): string {
  return `codegraph is unavailable (${reason}). Use the built-in read and grep tools instead.`;
}

/** Turn an unknown thrown value into a short reason. */
export function reasonOf(err: unknown): string {
  if (err instanceof CodegraphUnavailable) return err.reason;
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Absolute path of a result file, guarded to stay inside the index root. */
function absFile(root: string, filePath: string): string {
  const abs = path.resolve(root, filePath);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new CodegraphUnavailable(`index entry escapes the project root: ${filePath}`);
  }
  return abs;
}

/** Read source lines from disk (never from the index). */
function readSource(abs: string, startLine: number, endLine: number): string[] {
  const lines = fs.readFileSync(abs, "utf-8").split("\n");
  const out: string[] = [];
  for (let i = startLine - 1; i < Math.min(endLine, lines.length); i++) {
    if (i >= 0) out.push(`${i + 1}\t${lines[i]}`);
  }
  return out;
}

interface Cluster {
  start: number;
  end: number;
}

/** Merge line ranges with a gap tolerance into source clusters. */
function clusterLines(ranges: Array<[number, number]>, gap = 8, cap = 50): Cluster[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]).slice(0, cap);
  const clusters: Cluster[] = [];
  for (const [start, end] of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && start <= last.end + gap) {
      last.end = Math.max(last.end, end);
    } else {
      clusters.push({ start, end });
    }
  }
  return clusters;
}

function nodeLoc(n: Node): string {
  return `${n.filePath}:${n.startLine}`;
}

export interface EdgeRef {
  node: Node;
  edge: Edge;
}

function renderEdges(label: string, refs: EdgeRef[]): string[] {
  const out = [`${label} (${refs.length}):`];
  if (refs.length === 0) {
    out.push(`  (none found)`);
    return out;
  }
  // Top references first: a caller that calls the target on many lines is
  // more relevant than one that calls it once.
  const bySource = new Map<string, number>();
  for (const r of refs) bySource.set(r.node.id, (bySource.get(r.node.id) ?? 0) + 1);
  const ordered = [...refs].sort(
    (a, b) =>
      (bySource.get(b.node.id) ?? 0) - (bySource.get(a.node.id) ?? 0),
  );
  for (const { node, edge } of ordered.slice(0, 30)) {
    const line = edge.line ? nodeLoc(node) : node.filePath;
    const via = edge.kind === "calls" ? "" : ` [${edge.kind}]`;
    out.push(`  ${node.name} @ ${line}${via}`);
  }
  if (refs.length > 30) {
    out.push(`  ... ${refs.length - 30} more`);
  }
  return out;
}

// ------------------------------------------------------------------
// codegraph_search
// ------------------------------------------------------------------

export function renderSearch(
  cg: CodeGraph,
  query: string,
  kinds?: NodeKind[],
  limit = 10,
  offset = 0,
): string {
  const results: SearchResult[] = cg.searchNodes(query, { kinds, limit, offset });
  if (results.length === 0) {
    return `No symbols found matching "${query}"`;
  }
  const out: string[] = [`Results: ${results.length}`, ""];
  results.forEach((r, i) => {
    const n = r.node;
    const sig = n.signature ? ` ${n.signature}` : "";
    out.push(`${i + 1}. ${n.name} (${n.kind}) - ${n.filePath}:${n.startLine}${sig}`);
  });
  return out.join("\n");
}

// ------------------------------------------------------------------
// symbol resolution (shared by node/callers/callees/impact)
// ------------------------------------------------------------------

function matchesSymbol(node: Node, qualified: string): boolean {
  const q = qualified.replace(/\s+/g, "");
  const qn = node.qualifiedName.replace(/\s+/g, "");
  if (qn === q) return true;
  const last = q.split(/[./:]/).pop() ?? q;
  if (q.includes(".") && (qn.endsWith(`.${q}`) || node.name === last)) return true;
  if (q.includes("::") && qn.endsWith(`::${last}`)) return true;
  if (q.includes("/") && qn.endsWith(`/${last}`)) return true;
  return false;
}

export interface SymbolMatch {
  node: Node;
  /** True when the query was a bare name with several definitions. */
  ambiguous: boolean;
}

function narrow(matches: Node[], file?: string, line?: number): Node[] {
  if (matches.length <= 1) return matches;
  let out = matches;
  if (file) {
    const f = file.replace(/^\.\//, "");
    const byFile = out.filter(
      (n) => n.filePath === f || n.filePath.endsWith(`/${f}`),
    );
    if (byFile.length > 0) out = byFile;
  }
  if (line) {
    const inBody = out.filter(
      (n) => line >= n.startLine && line <= n.endLine,
    );
    if (inBody.length > 0) return inBody;
    out.sort(
      (a, b) =>
        Math.abs(a.startLine - line) - Math.abs(b.startLine - line),
    );
  }
  return out;
}

/**
 * Resolve a symbol name to indexed nodes: exact name match first (all
 * definitions), then qualified-name filtering, then a fuzzy search fallback.
 */
export function findSymbols(
  cg: CodeGraph,
  symbol: string,
  file?: string,
  line?: number,
): Node[] {
  const trimmed = symbol.trim();
  if (!trimmed) return [];
  const qualified = /[.\/:]/.test(trimmed);
  let matches: Node[];
  if (qualified) {
    const found = cg
      .searchNodes(trimmed, { limit: 50 })
      .map((r) => r.node)
      .filter((n) => matchesSymbol(n, trimmed));
    matches = found;
    if (matches.length === 0) {
      const bare = trimmed.split(/[.\/:]/).pop() ?? trimmed;
      matches = cg.getNodesByName(bare);
    }
  } else {
    matches = cg.getNodesByName(trimmed);
    if (matches.length === 0) {
      const found = cg.searchNodes(trimmed, { limit: 10 });
      const exact = found.filter((r) => r.node.name === trimmed).map((r) => r.node);
      matches = exact.length > 0 ? exact : found.slice(0, 1).map((r) => r.node);
    }
  }
  matches = narrow(matches, file, line);
  if (matches.length > 8) {
    matches = matches.slice(
      0,
      8,
    );
  }
  return matches;
}

function renderAmbiguity(matches: Node[]): string[] {
  const out = [
    `Multiple definitions of "${matches[0].name}" (${matches.length} found). Re-call with a file or line to pick one:`,
  ];
  for (const n of matches.slice(0, 10)) {
    out.push(`  - ${n.name} @ ${nodeLoc(n)}`);
  }
  return out;
}

// ------------------------------------------------------------------
// codegraph_node: symbol mode
// ------------------------------------------------------------------

export function renderSymbol(
  cg: CodeGraph,
  root: string,
  symbol: string,
  includeCode: boolean,
  file?: string,
  line?: number,
): string {
  const matches = findSymbols(cg, symbol, file, line);
  if (matches.length === 0) {
    return `Symbol "${symbol}" not found`;
  }
  const lines: string[] = [];
  if (matches.length > 1) {
    lines.push(...renderAmbiguity(matches));
    lines.push("");
  }
  for (const node of matches) {
    const sig = node.signature ? `\nSignature: ${node.signature}` : "";
    lines.push(`${node.name} (${node.kind}) - ${nodeLoc(node)}${sig}`);
    if (includeCode) {
      let abs: string;
      try {
        abs = absFile(root, node.filePath);
      } catch (err) {
        lines.push(`  (source unavailable: ${reasonOf(err)})`);
        continue;
      }
      try {
        const body = readSource(
          abs,
          node.startLine,
          Math.min(node.endLine, node.startLine + MAX_BODY_LINES - 1),
        );
        lines.push("");
        lines.push(...body);
        if (node.endLine > node.startLine + MAX_BODY_LINES - 1) {
          lines.push(`  ... truncated at ${MAX_BODY_LINES} lines`);
        }
      } catch {
        lines.push(`  (source file missing on disk: ${node.filePath})`);
      }
      const callers = cg.getCallers(node.id).slice(0, 12);
      const callees = cg.getCallees(node.id).slice(0, 12);
      lines.push("");
      lines.push(...renderEdges("Top callers", callers));
      lines.push("");
      lines.push(...renderEdges("Top callees", callees));
    }
  }
  return lines.join("\n");
}

// ------------------------------------------------------------------
// codegraph_node: file mode
// ------------------------------------------------------------------

export type FileResolveStatus =
  | { status: "ok"; abs: string; filePath: string }
  | { status: "ambiguous"; candidates: string[] }
  | { status: "notfound"; tried: string };

export function resolveIndexedFile(
  cg: CodeGraph,
  root: string,
  file: string,
): FileResolveStatus {
  const normalized = file.replace(/\\/g, "/").replace(/^\.\//, "");
  const files = cg.getFiles();
  const exact = files.filter((f) => f.path === normalized);
  let candidates: string[];
  if (exact.length === 1) {
    candidates = exact.map((f) => f.path);
  } else if (exact.length > 1) {
    return { status: "ambiguous", candidates: exact.map((f) => f.path) };
  } else {
    const suffix = files.filter((f) => f.path.endsWith(`/${normalized}`));
    if (suffix.length === 1) {
      candidates = suffix.map((f) => f.path);
    } else if (suffix.length > 1) {
      return {
        status: "ambiguous",
        candidates: suffix.map((f) => f.path).slice(0, 10),
      };
    } else {
      const partial = files
        .filter((f) => f.path.includes(normalized))
        .map((f) => f.path)
        .slice(0, 10);
      if (partial.length === 1) {
        candidates = partial;
      } else if (partial.length > 1) {
        return { status: "ambiguous", candidates: partial };
      } else {
        return { status: "notfound", tried: normalized };
      }
    }
  }
  return { status: "ok", abs: absFile(root, candidates[0]), filePath: candidates[0] };
}

export function renderFileView(
  cg: CodeGraph,
  root: string,
  file: string,
  offset?: number,
  limit?: number,
  symbolsOnly?: boolean,
): string {
  const resolved = resolveIndexedFile(cg, root, file);
  if (resolved.status === "notfound") {
    return `File "${resolved.tried}" not found in the index. Use the built-in read tool for files outside the index.`;
  }
  if (resolved.status === "ambiguous") {
    return [
      `Ambiguous file "${file}" - matches multiple indexed files:`,
      ...resolved.candidates.map((c) => `  - ${c}`),
      "",
      "Re-call with the full path from the project root.",
    ].join("\n");
  }
  let text: string;
  try {
    text = fs.readFileSync(resolved.abs, "utf-8");
  } catch {
    return `File ${resolved.filePath} is in the index but missing on disk (it may have been deleted). Re-run a build to refresh the index.`;
  }
  const lines = text.split("\n");
  const header = [
    `File: ${resolved.filePath} (${lines.length} lines)`,
    `Indexed symbols: ${cg.getNodesInFile(resolved.filePath).length}`,
  ];
  const dependents = cg.getFileDependents(resolved.filePath);
  if (dependents.length > 0) {
    header.push(
      `Depended on by: ${dependents.slice(0, 5).join(", ")}${dependents.length > 5 ? ` ... (+${dependents.length - 5} more)` : ""}`,
    );
  }
  if (symbolsOnly) {
    const symbols = cg
      .getNodesInFile(resolved.filePath)
      .filter((n) => n.kind !== "file" && n.kind !== "import" && n.kind !== "export")
      .sort((a, b) => a.startLine - b.startLine);
    const rows = symbols.map((n) => `  ${n.name} (${n.kind}) [${n.startLine}-${n.endLine}]`);
    return [...header, "", "Symbols:", ...rows].join("\n");
  }
  const start = Math.max(1, offset ?? 1);
  const end = Math.min(lines.length, start + (limit ?? DEFAULT_VIEW_LIMIT) - 1);
  const body = lines.slice(start - 1, end).map((l, i) => `${start + i}\t${l}`);
  const foot = end < lines.length ? [`... ${lines.length - end} more lines (use offset to continue)`] : [];
  return [...header, "", ...body, ...foot].join("\n");
}

// ------------------------------------------------------------------
// codegraph_callers / codegraph_callees
// ------------------------------------------------------------------

export function renderRefs(
  cg: CodeGraph,
  symbol: string,
  direction: "callers" | "callees",
  file?: string,
  line?: number,
): string {
  const matches = findSymbols(cg, symbol, file, line);
  if (matches.length === 0) return `Symbol "${symbol}" not found`;
  const label = direction === "callers" ? "callers" : "callees";
  if (matches.length > 1) {
    const out: string[] = [...renderAmbiguity(matches), ""];
    for (const node of matches.slice(0, 3)) {
      const refs = direction === "callers"
        ? cg.getCallers(node.id)
        : cg.getCallees(node.id);
      out.push(`--- ${node.name} @ ${nodeLoc(node)} ---`);
      out.push(...renderEdges(label, refs));
      out.push("");
    }
    return out.join("\n");
  }
  const node = matches[0];
  const refs = direction === "callers" ? cg.getCallers(node.id) : cg.getCallees(node.id);
  const out: string[] = [
    `${node.name} (${node.kind}) @ ${nodeLoc(node)}:`,
  ];
  out.push(...renderEdges(label, refs));
  return out.join("\n");
}

// ------------------------------------------------------------------
// codegraph_impact
// ------------------------------------------------------------------

export function renderImpact(
  cg: CodeGraph,
  symbol: string,
  depth: number,
  file?: string,
  line?: number,
): string {
  const matches = findSymbols(cg, symbol, file, line);
  if (matches.length === 0) return `Symbol "${symbol}" not found`;
  if (matches.length > 1) {
    return [
      `Multiple definitions of "${matches[0].name}" (${matches.length} found). Re-call with a file or line to pick one:`,
      ...matches.slice(0, 10).map((n) => `  - ${n.name} @ ${nodeLoc(n)}`),
    ].join("\n");
  }
  const node = matches[0];
  const subgraph = cg.getImpactRadius(node.id, depth);
  const byFile = new Map<string, Node[]>();
  for (const n of subgraph.nodes.values()) {
    if (n.id === node.id) continue;
    if (n.kind === "file" || n.kind === "import" || n.kind === "export") continue;
    const list = byFile.get(n.filePath) ?? [];
    list.push(n);
    byFile.set(n.filePath, list);
  }
  const out: string[] = [
    `Impact of ${node.name} @ ${nodeLoc(node)} (depth ${depth}):`,
    `  ${subgraph.nodes.size - 1} affected symbol(s) across ${byFile.size} file(s)`,
  ];
  const files = [...byFile.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [filePath, nodes] of files.slice(0, 25)) {
    out.push(`  ${filePath}:`);
    for (const n of nodes.slice(0, 8)) {
      out.push(`    - ${n.name} (${n.kind}) [${n.startLine}-${n.endLine}]`);
    }
    if (nodes.length > 8) out.push(`    ... ${nodes.length - 8} more`);
  }
  if (files.length > 25) out.push(`  ... ${files.length - 25} more files`);
  return out.join("\n");
}

// ------------------------------------------------------------------
// codegraph_explore
// ------------------------------------------------------------------

const EXPLORE_DEFAULT_MAX_FILES = 12;

export async function renderExplore(
  cg: CodeGraph,
  root: string,
  query: string,
  maxFiles = EXPLORE_DEFAULT_MAX_FILES,
): Promise<string> {
  const subgraph: Subgraph = await cg.findRelevantContext(query, {
    searchLimit: 8,
    traversalDepth: 2,
    maxNodes: 60,
  });
  if (subgraph.nodes.size === 0) {
    return `No relevant context found for "${query}"`;
  }
  const out: string[] = [`Context: ${query}`, ""];

  const byFile = new Map<string, Node[]>();
  for (const node of subgraph.nodes.values()) {
    if (node.kind === "file" || node.kind === "import" || node.kind === "export") continue;
    const list = byFile.get(node.filePath) ?? [];
    list.push(node);
    byFile.set(node.filePath, list);
  }
  const files = [...byFile.entries()].sort((a, b) => b[1].length - a[1].length);

  for (const [filePath, nodes] of files) {
    out.push(`## ${filePath}`);
    for (const n of nodes.sort((a, b) => a.startLine - b.startLine)) {
      const sig = n.signature ? ` ${n.signature}` : "";
      out.push(`  ${n.name} (${n.kind}) [${n.startLine}-${n.endLine}]${sig}`);
    }
    out.push("");
    let abs: string;
    try {
      abs = absFile(root, filePath);
    } catch {
      continue;
    }
    try {
      const clusters = clusterLines(
        nodes.map((n) => [n.startLine, Math.min(n.endLine, n.startLine + MAX_BODY_LINES - 1)]),
        8,
        5,
      );
      for (const cluster of clusters) {
        const body = readSource(
          abs,
          cluster.start,
          Math.min(cluster.end, cluster.start + MAX_EXPLORE_LINES_PER_FILE - 1),
        );
        if (body.length > MAX_EXPLORE_LINES_PER_FILE) {
          out.push(...body.slice(0, MAX_EXPLORE_LINES_PER_FILE));
          out.push("  ... (cluster truncated)");
        } else {
          out.push(...body);
        }
      }
    } catch {
      out.push(`  (source file missing on disk: ${filePath})`);
    }
    out.push("");
  }

  const callEdges = subgraph.edges.filter((e) => e.kind === "calls");
  if (callEdges.length > 0) {
    out.push("Call paths:");
    const byId = subgraph.nodes;
    let count = 0;
    for (const e of callEdges) {
      const s = byId.get(e.source);
      const t = byId.get(e.target);
      if (!s || !t) continue;
      out.push(`  ${s.name} (${s.filePath}:${s.startLine}) --calls--> ${t.name} (${t.filePath}:${t.startLine})`);
      if (++count >= MAX_CALL_PATHS) {
        out.push(`  ... ${callEdges.length - count} more`);
        break;
      }
    }
    out.push("");
  }
  return out.join("\n");
}
