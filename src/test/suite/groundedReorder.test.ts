import { suite, it } from "mocha";
import { expect } from "chai";
import {
  groundedReorder,
  applyCompletion,
  DEFAULT_MAX_COMPLETIONS_PER_DIAGNOSTIC,
  DEFAULT_MAX_INSTRUMENT_CALLS,
} from "../../assistant/groundedReorder";
import type { CompileInstrument } from "../../assistant/groundedReorder";
import getCompilerDiagnostics from "../../assistant/requests/getCompilerDiagnostics";
import type { AssistantDiagnostic } from "../../assistant/AssistantDiagnostic";

// Deterministic stand-in for the compiler instrument. It implements the same
// contract as the real getCompilerDiagnostics ((code, fileName) => Promise<string[]>)
// — verified below — reporting one flaw per occurrence of the token "BUG", so the
// propose -> instrument -> revise pass is testable without the assistant binary.
const fakeInstrument = (code: string): Promise<string[]> => {
  const flaws: string[] = [];
  let i = code.indexOf("BUG");
  while (i !== -1) {
    flaws.push(`error at ${i}`);
    i = code.indexOf("BUG", i + 1);
  }
  return Promise.resolve(flaws);
};

function makeDiagnostic(
  start: number,
  end: number,
  completions: { value: string; score: number; message: string }[]
): AssistantDiagnostic {
  return {
    range: { start, end },
    completionList: completions,
    reference: "BUG",
    currentLine: 0,
    references: [],
    responseId: "resp",
  };
}

// "const x = BUG;\n" -> BUG occupies indices 10..12, so range [10, 13).
const CODE = "const x = BUG;\n";
const BUG_START = 10;
const BUG_END = 13;

suite("grounded reorder (interaction scaling)", () => {
  it("the existing getCompilerDiagnostics matches the CompileInstrument contract", () => {
    // The production wiring in diagnostics.ts passes getCompilerDiagnostics as
    // the instrument; confirm the existing module still has that shape.
    expect(getCompilerDiagnostics).to.be.a("function");
    expect(getCompilerDiagnostics.length).to.equal(2);
  });

  it("applyCompletion splices a candidate into the diagnostic range", () => {
    const diag = makeDiagnostic(BUG_START, BUG_END, []);
    expect(
      applyCompletion(CODE, diag, { value: "0", score: 0, message: "" })
    ).to.equal("const x = 0;\n");
  });

  it("re-ranks completions so the grounded-best fix surfaces first", async () => {
    // High model score but leaves the flaw in place; low score but compiles clean.
    const diag = makeDiagnostic(BUG_START, BUG_END, [
      { value: "BUG", score: 90, message: "model-favorite, still broken" },
      { value: "0", score: 10, message: "low score, compiles clean" },
    ]);
    const [reordered] = await groundedReorder(
      CODE,
      "f.ts",
      [diag],
      fakeInstrument
    );
    // The clean-compiling completion ranks first despite its lower model score.
    expect(reordered.completionList[0].value).to.equal("0");
    expect(reordered.completionList[1].value).to.equal("BUG");
    // The original diagnostic is not mutated.
    expect(diag.completionList[0].value).to.equal("BUG");
  });

  it("demotes a candidate the instrument says makes things worse", async () => {
    // Introducing an extra BUG is a grounded regression and must sink below
    // a neutral (unvalidated) candidate.
    const diag = makeDiagnostic(BUG_START, BUG_END, [
      { value: "BUG+BUG", score: 80, message: "adds a flaw" },
      { value: "maybe", score: 20, message: "neutral" },
    ]);
    const [reordered] = await groundedReorder(
      CODE,
      "f.ts",
      [diag],
      fakeInstrument,
      {
        maxInstrumentCalls: 2, // baseline + one candidate only -> "maybe" stays neutral
      }
    );
    expect(reordered.completionList[0].value).to.equal("maybe");
    expect(reordered.completionList[1].value).to.equal("BUG+BUG");
  });

  it("is a no-op for diagnostics with a single candidate", async () => {
    const diag = makeDiagnostic(BUG_START, BUG_END, [
      { value: "1", score: 50, message: "" },
    ]);
    const [out] = await groundedReorder(CODE, "f.ts", [diag], fakeInstrument);
    expect(out.completionList.map((c) => c.value)).to.deep.equal(["1"]);
  });

  it("respects the instrument-call budget", async () => {
    const calls: string[] = [];
    const instrument: CompileInstrument = (c: string): Promise<string[]> => {
      calls.push(c);
      return fakeInstrument(c);
    };
    const diags = [
      makeDiagnostic(BUG_START, BUG_END, [
        { value: "a", score: 5, message: "" },
        { value: "b", score: 4, message: "" },
      ]),
      makeDiagnostic(BUG_START, BUG_END, [
        { value: "c", score: 3, message: "" },
        { value: "d", score: 2, message: "" },
      ]),
    ];
    await groundedReorder(CODE, "f.ts", diags, instrument, {
      maxInstrumentCalls: 3, // 1 baseline + 2 candidates; second diagnostic untouched
    });
    expect(calls.length).to.equal(3);
  });

  it("skips interaction entirely when given no compute budget", async () => {
    let calls = 0;
    const instrument: CompileInstrument = (): Promise<string[]> => {
      calls += 1;
      return Promise.resolve([]);
    };
    const diag = makeDiagnostic(BUG_START, BUG_END, [
      { value: "a", score: 5, message: "" },
      { value: "b", score: 4, message: "" },
    ]);
    const [out] = await groundedReorder(CODE, "f.ts", [diag], instrument, {
      maxInstrumentCalls: 0,
    });
    expect(calls).to.equal(0);
    expect(out.completionList.map((c) => c.value)).to.deep.equal(["a", "b"]);
  });

  it("keeps the default pass bounded", () => {
    expect(DEFAULT_MAX_COMPLETIONS_PER_DIAGNOSTIC)
      .to.be.a("number")
      .and.to.be.within(1, 5);
    expect(DEFAULT_MAX_INSTRUMENT_CALLS)
      .to.be.a("number")
      .and.to.be.within(1, 20);
  });
});
