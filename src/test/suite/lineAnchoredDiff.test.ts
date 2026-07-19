import { suite, it } from "mocha";
import { expect } from "chai";
import { Completion } from "../../assistant/Completion";
import {
  formatLineAnchoredEdit,
  formatAnchoredChoice,
} from "../../assistant/lineAnchoredDiff";

// Exercises the line-anchored formatter that diagnostics.ts now calls when
// building assistant quick-fix messages. Completion is imported from the
// existing (non-new) assistant module so the inputs match the shape the call
// site actually receives, not a parallel self-test fixture.
suite("line anchored diff", () => {
  suite("formatLineAnchoredEdit", () => {
    it("anchors a single-line replacement to the source line", () => {
      const rendered = formatLineAnchoredEdit("b", "B", 2);
      expect(rendered).to.equal("L2: - b\nL2: + B");
    });

    it("renders only the changed line of a multi-line block", () => {
      const rendered = formatLineAnchoredEdit("a\nb\nc", "a\nB\nc", 1);
      expect(rendered).to.equal("L2: - b\nL2: + B");
    });

    it("anchors an inserted line at the insertion point", () => {
      const rendered = formatLineAnchoredEdit("a\nc", "a\nb\nc", 1);
      expect(rendered).to.equal("L2: + b");
    });

    it("anchors a deleted line at the line it occupied", () => {
      const rendered = formatLineAnchoredEdit("a\nb\nc", "a\nc", 1);
      expect(rendered).to.equal("L2: - b");
    });

    it("renders nothing when reference and replacement match", () => {
      expect(formatLineAnchoredEdit("a\nb", "a\nb", 1)).to.equal("");
    });
  });

  suite("formatAnchoredChoice", () => {
    it("keeps the literal value for single-line edits", () => {
      const choice: Completion = {
        message: "replace token with",
        value: "bar",
        score: 92,
      };
      expect(formatAnchoredChoice(choice, "foo", 5)).to.equal(
        "replace token with 'bar'"
      );
    });

    it("switches to the line-anchored view for multi-line edits", () => {
      const choice: Completion = {
        message: "rewrite loop",
        value: "for (const item of items) {\n  total += item;\n}",
        score: 88,
      };
      const reference = "for (const item of items) {\n  total = item;\n}";
      const rendered = formatAnchoredChoice(choice, reference, 10);
      expect(rendered).to.equal(
        "rewrite loop:\nL11: -   total = item;\nL11: +   total += item;"
      );
    });
  });
});
