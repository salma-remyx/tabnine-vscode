import * as vscode from "vscode";
import { afterEach, after, beforeEach, describe, it } from "mocha";
import { expect } from "chai";
import getEditorContext from "../../tabnineChatWidget/handlers/context/editorContext";
import { toLineAnchoredCode } from "../../tabnineChatWidget/handlers/context/lineAnchoredCode";
import { activate } from "./utils/helper";

const CONFIG_SECTION = "tabnine";
const CONFIG_KEY = "chat.lineAnchoredContext";
// Cursor will rest on the second source line (index 1).
const SOURCE = ["import foo", "const x = 1", "export default x"].join("\n");
const CURSOR_LINE_INDEX = 1;

async function setLineAnchoredContext(
  value: boolean | undefined
): Promise<void> {
  await vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .update(CONFIG_KEY, value, vscode.ConfigurationTarget.Global);
}

describe("Line-anchored editor context wiring", () => {
  let editor: vscode.TextEditor | undefined;

  beforeEach(async () => {
    editor = (await activate())?.editor;
    expect(editor).to.not.equal(undefined);
    editor = editor as vscode.TextEditor;
    await editor.edit((edit) => {
      edit.insert(new vscode.Position(0, 0), SOURCE);
    });
    editor.selection = new vscode.Selection(
      new vscode.Position(CURSOR_LINE_INDEX, 0),
      new vscode.Position(CURSOR_LINE_INDEX, 0)
    );
    await setLineAnchoredContext(false);
  });

  afterEach(async () => {
    await setLineAnchoredContext(undefined);
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  });

  after(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  it("passes the raw file code through when the setting is disabled", async () => {
    const context = await getEditorContext(editor as vscode.TextEditor);

    expect(context?.type).to.equal("Editor");
    if (context?.type === "Editor") {
      expect(context.fileCode).to.equal(SOURCE);
      expect(context.currentLineIndex).to.equal(CURSOR_LINE_INDEX);
    }
  });

  it("anchors every line and marks the cursor line when the setting is enabled", async () => {
    await setLineAnchoredContext(true);

    const context = await getEditorContext(editor as vscode.TextEditor);

    expect(context?.type).to.equal("Editor");
    if (context?.type === "Editor") {
      expect(context.fileCode).to.equal(
        toLineAnchoredCode(SOURCE, CURSOR_LINE_INDEX)
      );
      expect(context.fileCode).to.contain("  1 | import foo");
      expect(context.fileCode).to.contain("> 2 | const x = 1");
      expect(context.fileCode).to.contain("  3 | export default x");
    }
  });
});

describe("toLineAnchoredCode", () => {
  it("returns an empty string for empty input", () => {
    expect(toLineAnchoredCode("")).to.equal("");
  });

  it("anchors a single line and leaves it unmarked without a cursor", () => {
    expect(toLineAnchoredCode("hello")).to.equal("  1 | hello");
  });

  it("right-aligns line numbers once the file reaches ten lines", () => {
    const tenLineFile = `${"x\n".repeat(9)}x`;
    const anchored = toLineAnchoredCode(tenLineFile);

    expect(anchored).to.contain("   1 | x");
    expect(anchored).to.contain("  10 | x");
  });

  it("marks only the requested current line", () => {
    const anchored = toLineAnchoredCode("a\nb\nc", 1);

    expect(anchored.split("\n")).to.deep.equal([
      "  1 | a",
      "> 2 | b",
      "  3 | c",
    ]);
  });
});
