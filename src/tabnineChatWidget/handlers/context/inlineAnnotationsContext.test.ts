import type * as vscode from "vscode";
// eslint-disable-next-line import/no-extraneous-dependencies
import { expect } from "chai";
import { getEnrichingContext } from "./enrichingContextHandler";
import getInlineAnnotationsContext, {
  parseAnnotation,
  scanInlineAnnotations,
} from "./inlineAnnotationsContext";

describe("parseAnnotation", () => {
  it("parses a full-line TODO comment with a colon", () => {
    expect(parseAnnotation("  // TODO: fix the off-by-one")).to.deep.equal({
      comment: "fix the off-by-one",
      marker: "TODO",
    });
  });

  it("parses a FIXME marker introduced by a hash", () => {
    expect(parseAnnotation("# FIXME handle null")).to.deep.equal({
      comment: "handle null",
      marker: "FIXME",
    });
  });

  it("parses a NOTE without trailing punctuation", () => {
    expect(parseAnnotation("-- NOTE this is subtle")).to.deep.equal({
      comment: "this is subtle",
      marker: "NOTE",
    });
  });

  it("parses a trailing comment after code", () => {
    expect(parseAnnotation("const x = 1; // rename me later")).to.deep.equal({
      comment: "rename me later",
    });
  });

  it("parses a plain comment with no marker", () => {
    expect(parseAnnotation("// this looks fragile")).to.deep.equal({
      comment: "this looks fragile",
    });
  });

  it("ignores // inside a URL scheme", () => {
    expect(
      parseAnnotation('const url = "https://example.com/path"')
    ).to.equal(undefined);
  });

  it("ignores plain code lines", () => {
    expect(parseAnnotation("const x = 1;")).to.equal(undefined);
    expect(parseAnnotation("")).to.equal(undefined);
  });
});

describe("scanInlineAnnotations", () => {
  it("collects only the comment lines as structured items", () => {
    const lines = [
      "function add(a, b) {",
      "  // TODO: validate inputs",
      "  return a + b;",
      "  // FIXME negative numbers break this",
      "}",
    ];
    const result = scanInlineAnnotations(
      (i) => lines[i],
      lines.length,
      [{ startLine: 0, endLineExclusive: lines.length }]
    );
    expect(result).to.deep.equal([
      {
        comment: "validate inputs",
        marker: "TODO",
        lineNumber: 2,
        lineCode: "// TODO: validate inputs",
      },
      {
        comment: "negative numbers break this",
        marker: "FIXME",
        lineNumber: 4,
        lineCode: "// FIXME negative numbers break this",
      },
    ]);
  });

  it("returns an empty list when no lines carry comments", () => {
    const lines = ["const x = 1;", "const y = 2;"];
    const result = scanInlineAnnotations(
      (i) => lines[i],
      lines.length,
      [{ startLine: 0, endLineExclusive: lines.length }]
    );
    expect(result).to.deep.equal([]);
  });

  it("scopes collection to the requested ranges only", () => {
    const lines = [
      "// TODO: first", // line 0 (out of range)
      "const a = 1;",
      "// TODO: second", // line 2 (in range)
    ];
    const result = scanInlineAnnotations(
      (i) => lines[i],
      lines.length,
      [{ startLine: 1, endLineExclusive: 3 }]
    );
    expect(result).to.have.length(1);
    expect(result[0].lineNumber).to.equal(3);
    expect(result[0].comment).to.equal("second");
  });
});

describe("getInlineAnnotationsContext", () => {
  it("exports structured line-anchored annotations under the new context type", async () => {
    const result = await getInlineAnnotationsContext(
      fakeEditor([
        "function add(a, b) {",
        "  // TODO: validate inputs",
        "  return a + b;",
        "  // FIXME negative numbers break this",
        "}",
      ])
    );
    expect(result).to.deep.equal({
      type: "InlineAnnotations",
      annotations: [
        {
          comment: "validate inputs",
          marker: "TODO",
          lineNumber: 2,
          lineCode: "// TODO: validate inputs",
        },
        {
          comment: "negative numbers break this",
          marker: "FIXME",
          lineNumber: 4,
          lineCode: "// FIXME negative numbers break this",
        },
      ],
    });
  });

  it("returns undefined when the document has no annotations", async () => {
    const result = await getInlineAnnotationsContext(
      fakeEditor(["const x = 1;", "const y = 2;"])
    );
    expect(result).to.equal(undefined);
  });

  it("scopes to a non-empty selection instead of visible ranges", async () => {
    const result = await getInlineAnnotationsContext(
      fakeEditor(
        ["// TODO: out of selection", "// TODO: in selection"],
        { startLine: 1, endLine: 2 }
      )
    );
    expect(result).to.deep.equal({
      type: "InlineAnnotations",
      annotations: [
        {
          comment: "in selection",
          marker: "TODO",
          lineNumber: 2,
          lineCode: "// TODO: in selection",
        },
      ],
    });
  });
});

describe("getEnrichingContext wiring", () => {
  it("keeps existing dispatch intact for an empty request", async () => {
    const result = await getEnrichingContext({ contextTypes: [] });
    expect(result).to.deep.equal({ enrichingContextData: [] });
  });
});

function fakeEditor(
  lines: string[],
  selection?: { startLine: number; endLine: number }
): vscode.TextEditor {
  const document = {
    lineCount: lines.length,
    lineAt: (i: number) => ({ text: lines[i], lineNumber: i }),
  };
  const editorSelection =
    selection === undefined
      ? {
          isEmpty: true,
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 },
        }
      : {
          isEmpty: false,
          start: { line: selection.startLine, character: 0 },
          end: { line: selection.endLine, character: 0 },
        };
  const visibleRanges = [
    { start: { line: 0, character: 0 }, end: { line: lines.length, character: 0 } },
  ];
  const editor = { document, selection: editorSelection, visibleRanges };
  return editor as unknown as vscode.TextEditor;
}
