import * as diff from "diff";

/**
 * Line-anchored suggestion formatting for Tabnine code review.
 *
 * Renders a code-edit suggestion as a minimal, line-anchored diff (only the
 * changed lines, each anchored to its line number) instead of restating the
 * whole suggested snippet. This is the "line-anchored feedback" format shown
 * to cut generated tokens and improve correctness in:
 *
 *   "Line-Anchored Feedback Cuts Token Costs and Improves Correctness in AI
 *    Code Editing" (https://arxiv.org/abs/2607.12713v1)
 *
 * Adapted for Tabnine's suggestion-output path (Mode 3 / inspired experiment).
 * The paper studies the format of feedback delivered to a GAI model, whose
 * prompt construction lives in Tabnine's binary / external chat repo and so is
 * not hostable in this thin client. Its measurable signal — that a
 * line-anchored representation of the same edit is much shorter than the
 * holistic snippet — applies equally to how a suggestion is surfaced to the
 * developer. `computeTokenSavings` reproduces the paper's headline measurement
 * (holistic vs. anchored token cost) using a parameter-free token proxy
 * (whitespace/symbol split) in place of a model tokenizer.
 */

export interface AnchoredChange {
  /** 1-based line number of the change in the suggested (new) text. */
  readonly line: number;
  /** Lines removed at this anchor. */
  readonly removed: readonly string[];
  /** Lines added at this anchor. */
  readonly added: readonly string[];
}

export interface LineAnchoredEdit {
  readonly changes: readonly AnchoredChange[];
  /** Total lines in the holistic suggested snippet (the "control" format). */
  readonly holisticLineCount: number;
  /** Lines that differ between old and new (added + removed). */
  readonly changedLineCount: number;
}

export interface SuggestionBody {
  /** Markdown source to pass to `vscode.MarkdownString.appendCodeblock`. */
  readonly content: string;
  /** Language hint to pass to `vscode.MarkdownString.appendCodeblock`. */
  readonly language: string;
}

export interface TokenSavings {
  readonly holisticTokens: number;
  readonly anchoredTokens: number;
  readonly savedTokens: number;
  /** Fraction of holistic tokens saved by anchoring. Negative when the
   * anchored form is longer (e.g. when the whole snippet changes). */
  readonly savedFraction: number;
}

const NEWLINE = /\r?\n/;

function splitLines(value: string): string[] {
  if (value === "") {
    return [];
  }
  // `diffLines` keeps a trailing newline on its parts; drop a single one so we
  // don't fabricate an empty final line.
  const trimmed = value.replace(/\r?\n$/, "");
  return trimmed === "" ? [] : trimmed.split(NEWLINE);
}

/**
 * Reduce an (oldText -> newText) edit to its line-anchored changes. Adjacent
 * removed/added parts are collapsed into a single change anchored at the line
 * where they occur in the suggested text.
 */
export function toLineAnchoredEdit(
  oldText: string,
  newText: string
): LineAnchoredEdit {
  const changes: AnchoredChange[] = [];
  let changedLineCount = 0;
  let newLine = 1;

  let pendingRemoved: string[] = [];
  let pendingAdded: string[] = [];
  let pendingAnchor = 0;

  const flush = (): void => {
    if (pendingRemoved.length === 0 && pendingAdded.length === 0) {
      return;
    }
    changes.push({
      line: pendingAnchor,
      removed: pendingRemoved,
      added: pendingAdded,
    });
    changedLineCount += pendingRemoved.length + pendingAdded.length;
    pendingRemoved = [];
    pendingAdded = [];
    pendingAnchor = 0;
  };

  diff.diffLines(oldText, newText).forEach((part) => {
    const lines = splitLines(part.value);
    if (part.removed) {
      if (pendingAnchor === 0) {
        pendingAnchor = newLine;
      }
      pendingRemoved.push(...lines);
    } else if (part.added) {
      if (pendingAnchor === 0) {
        pendingAnchor = newLine;
      }
      pendingAdded.push(...lines);
      newLine += lines.length;
    } else {
      flush();
      newLine += lines.length;
    }
  });
  flush();

  return {
    changes,
    holisticLineCount: splitLines(newText).length,
    changedLineCount,
  };
}

/** Render a line-anchored edit as a compact unified-diff-style string. */
export function formatLineAnchoredDiff(edit: LineAnchoredEdit): string {
  return edit.changes
    .map((change) => {
      const removed = change.removed.map((line) => `-${line}`);
      const added = change.added.map((line) => `+${line}`);
      return [`@@ line ${change.line} @@`, ...removed, ...added].join("\n");
    })
    .join("\n");
}

/**
 * Decide how to render a suggestion body. When the suggestion edits only part
 * of an existing snippet, render the line-anchored diff (treatment); otherwise
 * fall back to the holistic snippet (control).
 */
export function formatSuggestionBody(
  oldValue: string,
  suggestionValue: string,
  language: string
): SuggestionBody {
  if (!oldValue || oldValue === suggestionValue) {
    return { content: suggestionValue, language };
  }
  const edit = toLineAnchoredEdit(oldValue, suggestionValue);
  if (edit.changes.length === 0) {
    return { content: suggestionValue, language };
  }
  return { content: formatLineAnchoredDiff(edit), language: "diff" };
}

/**
 * Parameter-free token proxy: count whitespace/symbol-delimited runs. Stands
 * in for a BPE tokenizer — adequate for the holistic-vs-anchored ratio, which
 * is what the paper reports.
 */
export function approximateTokenCount(text: string): number {
  if (text === "") {
    return 0;
  }
  const matches = text.match(/[\w]+|[^\s\w]+/g);
  return matches ? matches.length : 0;
}

/**
 * Reproduce the paper's headline measurement — how many tokens the
 * line-anchored format saves versus the holistic snippet — for a single edit.
 */
export function computeTokenSavings(
  oldValue: string,
  suggestionValue: string
): TokenSavings {
  const holisticTokens = approximateTokenCount(suggestionValue);
  const edit = toLineAnchoredEdit(oldValue, suggestionValue);
  const anchoredTokens =
    edit.changes.length === 0
      ? holisticTokens
      : approximateTokenCount(formatLineAnchoredDiff(edit));
  const savedTokens = holisticTokens - anchoredTokens;
  return {
    holisticTokens,
    anchoredTokens,
    savedTokens,
    savedFraction: holisticTokens === 0 ? 0 : savedTokens / holisticTokens,
  };
}
