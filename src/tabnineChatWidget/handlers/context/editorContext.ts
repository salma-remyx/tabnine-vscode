import * as vscode from "vscode";
import { ContextTypeData, EditorContext } from "./enrichingContextTypes";
import {
  isLineAnchoredContextEnabled,
  toLineAnchoredCode,
} from "./lineAnchoredCode";

export type SelectedCodeResponsePayload =
  | undefined
  | {
      code: string;
      startLine: number;
      endLine: number;
    };

export default async function getEditorContext(
  editor: vscode.TextEditor
): Promise<ContextTypeData | undefined> {
  const fileCode = editor.document.getText();
  const currentLine = editor.document.lineAt(editor.selection.active);

  const editorContext: EditorContext = {
    fileCode: isLineAnchoredContextEnabled()
      ? toLineAnchoredCode(fileCode, currentLine.lineNumber)
      : fileCode,
    currentLineIndex: currentLine.lineNumber,
  };

  return Promise.resolve({
    type: "Editor",
    ...editorContext,
  });
}

export function getSelectedCode(): SelectedCodeResponsePayload {
  const editor = vscode.window.activeTextEditor;
  const selectedCode = editor?.document.getText(editor.selection);

  if (!selectedCode || !editor) {
    return undefined;
  }

  return {
    code: selectedCode,
    startLine: editor.selection.start.line + 1,
    endLine: editor.selection.end.line + 1,
  };
}
