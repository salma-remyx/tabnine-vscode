import * as diff from "diff";
import { Completion } from "./Completion";

/**
 * Line-anchored edit formatting for the Tabnine assistant quick-fix flow.
 *
 * Adapted from the "line-anchored feedback" delivery format described in
 * "Line-Anchored Feedback Cuts Token Costs and Improves Correctness in AI
 * Code Editing" (arXiv:2607.12713). The paper shows that presenting a
 * requested edit anchored to specific source lines — instead of repeating the
 * whole replacement block — cuts the text that has to be generated/read and
 * makes the change more precise, with the largest gains on multi-line files.
 *
 * These helpers turn an assistant replacement (`choice.value`) into a compact
 * view of only the lines that change, each tagged with its 1-based source line
 * number, so a diagnostic message or quick-fix title can surface what changes
 * where instead of echoing the full snippet.
 */

const ANCHOR_PREFIX = "L";
const REMOVED_MARKER = "-";
const ADDED_MARKER = "+";

/**
 * Renders only the differing lines between `reference` and `replacement` as a
 * line-anchored diff. Removed lines are tagged with the source line they
 * occupied; added lines are tagged with the line they replace or insert at.
 * Returns an empty string when the two are identical.
 */
export function formatLineAnchoredEdit(
  reference: string,
  replacement: string,
  startLine = 1
): string {
  const rows: string[] = [];
  let referenceLine = startLine;
  // Anchor shared by every line in one contiguous remove/add run: added lines
  // in a replacement bind to the same source line as the removals they follow.
  let hunkAnchor = startLine;
  let inChangeRun = false;

  diff.diffLines(reference, replacement).forEach((change) => {
    const lines = toLines(change.value);

    if (change.added) {
      if (!inChangeRun) {
        hunkAnchor = referenceLine;
        inChangeRun = true;
      }
      lines.forEach((line) =>
        rows.push(`${ANCHOR_PREFIX}${hunkAnchor}: ${ADDED_MARKER} ${line}`)
      );
    } else if (change.removed) {
      if (!inChangeRun) {
        hunkAnchor = referenceLine;
        inChangeRun = true;
      }
      lines.forEach((line) => {
        rows.push(
          `${ANCHOR_PREFIX}${referenceLine}: ${REMOVED_MARKER} ${line}`
        );
        referenceLine += 1;
      });
    } else {
      inChangeRun = false;
      referenceLine += lines.length;
    }
  });

  return rows.join("\n");
}

/**
 * Formats one assistant choice for display. Single-line edits keep the
 * existing `'value'` rendering; multi-line edits switch to the line-anchored
 * view so the diagnostic message shows what changes where instead of a
 * verbatim replacement block.
 */
export function formatAnchoredChoice(
  choice: Completion,
  reference: string,
  startLine: number
): string {
  if (isSingleLine(reference) && isSingleLine(choice.value)) {
    return `${choice.message} '${choice.value}'`;
  }
  return `${choice.message}:\n${formatLineAnchoredEdit(
    reference,
    choice.value,
    startLine
  )}`;
}

function toLines(value: string): string[] {
  const lines = value.split("\n");
  // jsdiff terminates each change with a newline; drop the empty slot it
  // produces so it is not counted or rendered as a line.
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function isSingleLine(text: string): boolean {
  return text.split("\n").length <= 1;
}
