import { suite, it } from "mocha";
import { expect } from "chai";
import {
  toLineAnchoredEdit,
  formatSuggestionBody,
  computeTokenSavings,
} from "../../codeReview/lineAnchoredDiff";
import TabnineComment from "../../codeReview/TabnineComment";

const OLD_SNIPPET = "const a = 1;\nconst b = 2;\nconst c = 3;\n";
const NEW_SNIPPET = "const a = 1;\nconst b = 22;\nconst c = 3;\n";

suite("line-anchored diff formatter", () => {
  it("anchors a single-line change to its line number", () => {
    const edit = toLineAnchoredEdit(OLD_SNIPPET, NEW_SNIPPET);

    expect(edit.holisticLineCount).to.equal(3);
    expect(edit.changes).to.have.length(1);
    expect(edit.changes[0].line).to.equal(2);
    expect(edit.changes[0].removed).to.deep.equal(["const b = 2;"]);
    expect(edit.changes[0].added).to.deep.equal(["const b = 22;"]);
  });

  it("reports no changes when old and new are identical", () => {
    const edit = toLineAnchoredEdit(OLD_SNIPPET, OLD_SNIPPET);

    expect(edit.changes).to.have.length(0);
    expect(edit.changedLineCount).to.equal(0);
  });

  it("falls back to the holistic snippet when there is no old value", () => {
    const body = formatSuggestionBody("", "const x = 1;", "typescript");

    expect(body.content).to.equal("const x = 1;");
    expect(body.language).to.equal("typescript");
  });

  it("renders a line-anchored diff for a partial change", () => {
    const body = formatSuggestionBody(OLD_SNIPPET, NEW_SNIPPET, "typescript");

    expect(body.language).to.equal("diff");
    expect(body.content).to.contain("@@ line 2 @@");
    expect(body.content).to.contain("-const b = 2;");
    expect(body.content).to.contain("+const b = 22;");
    // unchanged lines are not restated (the token-saving point)
    expect(body.content).to.not.contain("const a = 1;");
  });
});

suite("line-anchored token savings", () => {
  it("saves tokens when a small edit lands on a larger snippet", () => {
    // A multi-function snippet where exactly one line changes — the regime
    // where the paper reports anchoring helping most.
    const holistic = [
      "function add(a, b) {",
      "  return a + b;",
      "}",
      "function sub(a, b) {",
      "  return a - b;",
      "}",
      "function mul(a, b) {",
      "  return a * b;",
      "}",
      "",
    ].join("\n");
    const edited = holistic.replace(
      "  return a - b;",
      "  return a - b; // subtraction"
    );

    const savings = computeTokenSavings(holistic, edited);

    expect(savings.savedTokens).to.be.greaterThan(0);
    expect(savings.savedFraction).to.be.greaterThan(0);
    expect(savings.anchoredTokens).to.be.lessThan(savings.holisticTokens);
  });
});

// Integration: exercises the wiring edit in TabnineComment.body, which now
// delegates to formatSuggestionBody. Runs in the VS Code host (real vscode),
// so MarkdownString.appendCodeblock is the real implementation.
suite("TabnineComment line-anchored body", () => {
  it("renders a line-anchored diff for a partial suggestion", () => {
    const suggestion = {
      value: NEW_SNIPPET,
      classification: { type: "other", description: "bump b" },
    };
    const comment = new TabnineComment(OLD_SNIPPET, suggestion, "typescript");
    const body = comment.body.value;

    expect(body).to.contain("@@ line 2 @@");
    expect(body).to.contain("+const b = 22;");
    expect(body).to.contain("-const b = 2;");
  });

  it("renders the holistic snippet when there is no old value", () => {
    const suggestion = {
      value: "const x = 1;",
      classification: { type: "other", description: "new" },
    };
    const comment = new TabnineComment("", suggestion, "typescript");
    const body = comment.body.value;

    expect(body).to.contain("const x = 1;");
    expect(body).to.not.contain("@@ line");
  });
});
