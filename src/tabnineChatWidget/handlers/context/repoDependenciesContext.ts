import * as vscode from "vscode";
import { ContextTypeData } from "./enrichingContextTypes";
import { Logger } from "../../../utils/logger";
import {
  buildDependencyOrder,
  DEFAULT_CONTEXT_BUDGET,
  DEFAULT_MAX_DEPENDENCIES,
  DEFAULT_MAX_DEPTH,
  extractImportSpecifiers,
  resolveDependencyPath,
  selectWithinBudget,
} from "./repoDependencyGraph";

/**
 * Repo-dependency enriching context. Builds a compact, dependency-aware slice
 * of the workspace around the active file (HCP-style: resolve imports to a
 * dependency graph, order by relevance, prune bodies to fit a budget) and
 * forwards it to the binary under the existing `ContextTypeData` contract so
 * chat completions can use cross-file context without overflowing the window.
 *
 * See repoDependencyGraph.ts for the paper attribution and the mechanism.
 */

const DEPENDENCY_FILE_GLOB = "**/*.{ts,tsx,js,jsx,mjs,cjs,py}";
const MAX_CANDIDATE_FILES = 1000;

export default async function getRepoDependenciesContext(
  editor: vscode.TextEditor
): Promise<ContextTypeData | undefined> {
  const activePath = editor.document.uri.fsPath;
  const activeSource = editor.document.getText();
  try {
    const candidateUris = await vscode.workspace.findFiles(
      DEPENDENCY_FILE_GLOB,
      "**/node_modules/**",
      MAX_CANDIDATE_FILES
    );
    const candidatePaths = candidateUris.map((uri) => uri.fsPath);

    const sources = new Map<string, string>();
    sources.set(activePath, activeSource);
    await gatherDependencySources(
      activePath,
      candidatePaths,
      sources,
      new Set<string>([activePath]),
      0
    );
    if (sources.size <= 1) return undefined;

    const ordered = buildDependencyOrder(activePath, sources, {
      maxDepth: DEFAULT_MAX_DEPTH,
    }).slice(0, DEFAULT_MAX_DEPENDENCIES);
    if (ordered.length === 0) return undefined;

    const dependencies = selectWithinBudget(
      ordered,
      sources,
      DEFAULT_CONTEXT_BUDGET
    );
    if (dependencies.length === 0) return undefined;

    return { type: "RepoDependencies", dependencies };
  } catch (error) {
    Logger.warn(
      `failed to obtain repo dependencies context, continuing without it: ${
        (error as Error).message
      }`
    );
    return undefined;
  }
}

// Resolve and read the active file's dependency closure (bounded by depth and
// file count). Reads one level at a time so sibling deps are fetched in
// parallel via Promise.all.
async function gatherDependencySources(
  activePath: string,
  candidatePaths: string[],
  sources: Map<string, string>,
  visited: Set<string>,
  depth: number
): Promise<void> {
  if (
    depth >= DEFAULT_MAX_DEPTH ||
    sources.size > DEFAULT_MAX_DEPENDENCIES + 1
  ) {
    return;
  }
  const source = sources.get(activePath) ?? (await readFileText(activePath));
  if (!source) return;
  sources.set(activePath, source);

  const nextLevel: string[] = [];
  extractImportSpecifiers(source).forEach((spec) => {
    const dep = resolveDependencyPath(spec, activePath, candidatePaths);
    if (dep && !visited.has(dep)) {
      visited.add(dep);
      nextLevel.push(dep);
    }
  });
  await Promise.all(
    nextLevel.map((dep) =>
      gatherDependencySources(dep, candidatePaths, sources, visited, depth + 1)
    )
  );
}

async function readFileText(fsPath: string): Promise<string | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(fsPath));
    return Buffer.from(bytes).toString("utf8");
  } catch {
    return undefined;
  }
}
