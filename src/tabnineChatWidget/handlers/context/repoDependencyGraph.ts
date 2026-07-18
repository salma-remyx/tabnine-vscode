import * as path from "path";

/**
 * Dependency-aware repo-context shaping, adapted from "Hierarchical Context
 * Pruning" (HCP, arXiv:2406.18294). HCP models a repository at the function
 * level, orders units by their dependency topology, and prunes bodies
 * hierarchically so a relevant slice fits a fixed context window.
 *
 * This module keeps HCP's three core mechanisms — dependency modeling,
 * topological/relevance ordering, and budgeted body pruning — and is fully
 * deterministic and parameter-free (no learned components). The paper's
 * Repo-Code LLM and its training live in the binary; this module only shapes
 * the dependency context that the client forwards to it, so all of the
 * "intelligence" here is structural.
 *
 * Substitutions vs. the paper (Mode 2 / adapted port):
 *  - Function-level AST modeling -> import-specifier extraction + workspace
 *    path resolution (a parameter-free dependency proxy).
 *  - Learned relevance scoring -> BFS depth from the focal file (direct vs.
 *    transitive), used as the pruning priority.
 *  - Repo-Code LLM context window -> a configurable character budget.
 */

export type DependencyRelevance = "direct" | "transitive";

export type OrderedDependency = {
  path: string;
  /** 1 = direct import of the focal file, 2+ = transitive. */
  depth: number;
};

export type SelectedDependency = {
  path: string;
  code: string;
  relevance: DependencyRelevance;
  /** True when the body was pruned to signatures to fit the budget. */
  pruned: boolean;
};

export type BuildOrderOptions = {
  maxDepth?: number;
};

/** Default character budget for the pruned dependency slice. */
export const DEFAULT_CONTEXT_BUDGET = 6000;
/** Hard cap on how many dependency files we ever surface. */
export const DEFAULT_MAX_DEPENDENCIES = 20;
/** Default BFS depth when walking the dependency closure. */
export const DEFAULT_MAX_DEPTH = 3;

/** Relevance cutoff: depth <= this is "direct", deeper is "transitive". */
const DIRECT_MAX_DEPTH = 1;

const SOURCE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".json",
];

const IMPORT_SPECIFIER_PATTERNS: RegExp[] = [
  /\bfrom\s*['"]([^'"]+)['"]/, // JS/TS: from "x" (covers import/export, multi-line)
  /\bimport\s*['"]([^'"]+)['"]/, // JS/TS: side-effect import "x"
  /\bimport\s*\(\s*['"]([^'"]+)['"]/, // JS/TS: dynamic import("x")
  /\brequire\s*\(\s*['"]([^'"]+)['"]/, // JS/TS: require("x")
  /(?:^|[\s;])from\s+([A-Za-z0-9_.]+)\s+import\b/, // python: from x import
  /^\s*import\s+([A-Za-z0-9_.]+)(?=\s*(?:#|;|$))/m, // python: import x (line-anchored)
];

/** Run a single capture-group regex globally and collect group 1. */
function captureFirstGroup(pattern: RegExp, source: string): string[] {
  const flags = pattern.flags.includes("g")
    ? pattern.flags
    : `${pattern.flags}g`;
  const global = new RegExp(pattern.source, flags);
  const captures: string[] = [];
  let match: RegExpExecArray | null = global.exec(source);
  while (match !== null) {
    if (match[1]) captures.push(match[1]);
    match = global.exec(source);
  }
  return captures;
}

/**
 * Extract import specifiers from source text. Language-agnostic best-effort
 * covering the common JS/TS forms (`from "x"`, `import "x"`, `import("x")`,
 * `require("x")`) and Python forms (`from x import`, `import x`). Protocol
 * URLs and VS Code built-ins are excluded. Order is unspecified; results are
 * deduplicated.
 */
export function extractImportSpecifiers(source: string): string[] {
  const specifiers = new Set<string>();
  IMPORT_SPECIFIER_PATTERNS.forEach((pattern) => {
    captureFirstGroup(pattern, source).forEach((spec) => {
      if (!isExternalSpecifier(spec)) specifiers.add(spec);
    });
  });
  return [...specifiers];
}

function isExternalSpecifier(specifier: string): boolean {
  return (
    specifier.startsWith("http://") ||
    specifier.startsWith("https://") ||
    specifier.startsWith("vscode:") ||
    specifier.startsWith("node:")
  );
}

/**
 * Resolve an import specifier to a workspace file path given the importing
 * file and the set of candidate workspace paths. Relative specifiers are
 * resolved against the importer's directory with extension/index inference;
 * bare specifiers match only on a unique candidate to avoid ambiguity.
 */
export function resolveDependencyPath(
  specifier: string,
  fromPath: string,
  candidatePaths: string[]
): string | undefined {
  if (isExternalSpecifier(specifier)) return undefined;
  const candidates = new Set(candidatePaths);
  if (specifier.startsWith(".")) {
    const target = path.normalize(path.join(path.dirname(fromPath), specifier));
    return matchWithExtensions(target, candidates);
  }
  if (path.isAbsolute(specifier)) {
    return matchWithExtensions(path.normalize(specifier), candidates);
  }
  return matchBareSpecifier(specifier, candidates);
}

function matchWithExtensions(
  target: string,
  candidates: Set<string>
): string | undefined {
  if (candidates.has(target)) return target;
  const withExtension = SOURCE_EXTENSIONS.map(
    (ext) => target + ext
  ).find((candidate) => candidates.has(candidate));
  if (withExtension) return withExtension;
  return SOURCE_EXTENSIONS.map((ext) =>
    path.normalize(path.join(target, `index${ext}`))
  ).find((candidate) => candidates.has(candidate));
}

function matchBareSpecifier(
  specifier: string,
  candidates: Set<string>
): string | undefined {
  const seg = specifier.replace(/\./g, "/"); // python dotted name -> path
  const matches = new Set<string>();
  SOURCE_EXTENSIONS.forEach((ext) => {
    if (candidates.has(seg + ext)) matches.add(seg + ext);
  });
  candidates.forEach((candidate) => {
    if (
      candidate.endsWith(`/${seg}`) ||
      candidate.endsWith(`/${seg}.py`) ||
      candidate.endsWith(`/${seg}.ts`) ||
      candidate.endsWith(`/${seg}.js`)
    ) {
      matches.add(candidate);
    }
  });
  if (matches.size === 1) return [...matches][0];
  return undefined;
}

/**
 * Walk the dependency closure of the focal file and return its dependencies
 * (the focal file itself is excluded) ordered by relevance: shallowest depth
 * first, with a topological (dependencies-before-dependents) tiebreak so a
 * file always appears after its own dependencies.
 */
export function buildDependencyOrder(
  activePath: string,
  sources: Map<string, string>,
  options?: BuildOrderOptions
): OrderedDependency[] {
  const maxDepth = options?.maxDepth ?? DEFAULT_MAX_DEPTH;
  const normalized = new Map<string, string>();
  sources.forEach((src, filePath) => {
    normalized.set(path.normalize(filePath), src);
  });
  const candidatePaths = Array.from(normalized.keys());
  const root = path.normalize(activePath);

  const depsOf = (filePath: string): string[] => {
    const src = normalized.get(filePath);
    if (!src) return [];
    return extractImportSpecifiers(src)
      .map((spec) => resolveDependencyPath(spec, filePath, candidatePaths))
      .filter((dep): dep is string => dep !== undefined);
  };

  // BFS for shortest depth (= relevance).
  const depths = new Map<string, number>([[root, 0]]);
  const queue: string[] = [root];
  while (queue.length) {
    const current = queue.shift() as string;
    const depth = depths.get(current) as number;
    if (depth < maxDepth) {
      depsOf(current).forEach((dep) => {
        if (!depths.has(dep)) {
          depths.set(dep, depth + 1);
          queue.push(dep);
        }
      });
    }
  }
  depths.delete(root);

  // Topological index via DFS post-order over the reachable set.
  const topo = new Map<string, number>();
  const seen = new Set<string>([root]);
  let counter = 0;
  const visit = (filePath: string): void => {
    depsOf(filePath).forEach((dep) => {
      if (depths.has(dep) && !seen.has(dep)) {
        seen.add(dep);
        visit(dep);
        topo.set(dep, counter);
        counter += 1;
      }
    });
  };
  visit(root);

  return [...depths.entries()]
    .map((entry) => ({
      path: entry[0],
      depth: entry[1],
      topo: topo.get(entry[0]) ?? counter,
    }))
    .sort((a, b) => a.depth - b.depth || a.topo - b.topo)
    .map((entry) => ({ path: entry.path, depth: entry.depth }));
}

/**
 * Reduce a source file to its declaration signatures, dropping bodies — HCP's
 * hierarchical pruning applied at file granularity. Best-effort and tuned for
 * brace-delimited languages (the repo's JS/TS) with a simple Python pass.
 */
// Detect Python via signals that do not appear in brace-delimited languages:
// `def name(` and `from <module> import` (JS/TS `from` is always followed by
// a quote, not an identifier).
function looksLikePython(source: string): boolean {
  return (
    /\bdef\s+\w+\s*\(/.test(source) ||
    /\bfrom\s+[A-Za-z_]\w*\s+import\b/.test(source)
  );
}

export function pruneToSignatures(source: string): string {
  if (looksLikePython(source)) {
    return source
      .split("\n")
      .filter((line) => /^\s*(def |class |import |from )/.test(line))
      .join("\n");
  }
  const kept: string[] = [];
  let depth = 0;
  source.split("\n").forEach((line) => {
    if (depth > 0) {
      depth += netBraces(line);
      if (depth < 0) depth = 0;
      return;
    }
    const trimmed = line.trim();
    const isImport = /^(import|export)\b/.test(trimmed);
    const isDeclaration =
      /^(export\s+)?(default\s+)?(async\s+)?(function|class|interface|type|enum)\b/.test(
        trimmed
      ) || /^(export\s+)?(const|let|var)\b/.test(trimmed);
    if (isImport && !isDeclaration) {
      kept.push(line);
      return;
    }
    if (isDeclaration) {
      const open = line.indexOf("{");
      if (open >= 0) {
        kept.push(`${line.slice(0, open).trimEnd()} { ... }`);
        depth += netBraces(line);
        if (depth < 0) depth = 0;
      } else {
        kept.push(line);
      }
    }
  });
  return kept.join("\n");
}

function netBraces(line: string): number {
  let count = 0;
  line.split("").forEach((ch) => {
    if (ch === "{") count += 1;
    else if (ch === "}") count -= 1;
  });
  return count;
}

/**
 * Select dependencies to fit a character budget, walking in relevance order
 * (most relevant first): full source while it fits, then pruned signature
 * stubs, then dropped. Least-relevant dependencies are shed first.
 */
export function selectWithinBudget(
  ordered: OrderedDependency[],
  sources: Map<string, string>,
  budget = DEFAULT_CONTEXT_BUDGET
): SelectedDependency[] {
  const selected: SelectedDependency[] = [];
  let used = 0;
  ordered.forEach((dep) => {
    const full =
      sources.get(path.normalize(dep.path)) ?? sources.get(dep.path) ?? "";
    const relevance: DependencyRelevance =
      dep.depth <= DIRECT_MAX_DEPTH ? "direct" : "transitive";
    if (used + full.length <= budget) {
      selected.push({ path: dep.path, code: full, relevance, pruned: false });
      used += full.length;
      return;
    }
    const stub = pruneToSignatures(full);
    if (stub.length > 0 && used + stub.length <= budget) {
      selected.push({ path: dep.path, code: stub, relevance, pruned: true });
      used += stub.length;
    }
  });
  return selected;
}
