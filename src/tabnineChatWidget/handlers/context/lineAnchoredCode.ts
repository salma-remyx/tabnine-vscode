import * as vscode from "vscode";

/**
 * Line-anchored editor context formatter.
 *
 * Renders the active file's source as a listing in which every line carries
 * an explicit, 1-based line-number anchor (and a `>` marker on the cursor's
 * current line) before it is handed to Tabnine Chat as the `Editor`
 * enriching context. This mirrors the line-anchored export format shown to
 * cut the tokens a model generates when editing and to lift correctness:
 * with anchors in place the model can address precise line numbers instead
 * of reproducing whole regions of the file.
 *
 * Adapted from "Line-Anchored Feedback Cuts Token Costs and Improves
 * Correctness in AI Code Editing" (arXiv:2607.12713). The output is a plain
 * string, so the existing `ContextTypeData` I/O contract is preserved — only
 * the representation of `fileCode` changes when the feature is on.
 *
 * Opt-in: enable with the `tabnine.chat.lineAnchoredContext` setting. When
 * disabled, `getEditorContext` continues to send the raw file code unchanged.
 */

const LINE_ANCHORED_CONTEXT_CONFIG = "tabnine.chat.lineAnchoredContext";
const CURRENT_LINE_MARKER = ">";
const OTHER_LINE_MARKER = " ";
const ANCHOR_SEPARATOR = " | ";

export function isLineAnchoredContextEnabled(): boolean {
  return (
    vscode.workspace
      .getConfiguration()
      .get<boolean>(LINE_ANCHORED_CONTEXT_CONFIG) === true
  );
}

/**
 * Renders `fileCode` as a line-anchored listing. `currentLineIndex` is the
 * 0-based cursor line (matching `vscode.TextLine.lineNumber`); the matching
 * line is prefixed with `>`. Returns the empty string for empty input so an
 * empty file contributes no extra context.
 */
export function toLineAnchoredCode(
  fileCode: string,
  currentLineIndex?: number
): string {
  if (fileCode.length === 0) {
    return "";
  }

  const lines = fileCode.split("\n");
  const width = String(lines.length).length;

  return lines
    .map((line, index) => {
      const marker =
        index === currentLineIndex ? CURRENT_LINE_MARKER : OTHER_LINE_MARKER;
      const lineNumber = String(index + 1).padStart(width, " ");
      return `${marker} ${lineNumber}${ANCHOR_SEPARATOR}${line}`;
    })
    .join("\n");
}
