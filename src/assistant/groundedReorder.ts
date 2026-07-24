import type { AssistantDiagnostic } from "./AssistantDiagnostic";
import type { Completion } from "./Completion";

/**
 * Grounded re-ranking of assistant completions via compiler feedback.
 *
 * Adapted (Mode 2) from "Interaction Scaling: Grounding the Third Axis of
 * Test-Time Compute" (https://arxiv.org/abs/2607.11598). The paper identifies
 * a third axis of test-time compute beyond reasoning and sampling: interaction.
 * The model proposes an artifact, an external instrument observes how it
 * actually behaves, and the model revises. Each cycle imports a *real
 * observation*, which is what lets interaction break through the ceiling the
 * other two axes hit (both stay internal — extra tokens come from the same
 * frozen weights and prompt, so they can teach the model nothing new).
 *
 * The paper argues one variable governs this axis — *grounding*: both the
 * feedback that drives revision and the metric that scores the result must
 * come from an instrument that actually observes the flaw.
 *
 * This module runs a bounded propose -> instrument -> revise pass over the
 * completions the assistant already proposed:
 *   - propose:  `AssistantDiagnostic.completionList` candidates, produced by
 *     the existing `getAssistantDiagnostics` one-shot call.
 *   - instrument: a `CompileInstrument` with the same contract as the repo's
 *     `getCompilerDiagnostics` `(code, fileName) => Promise<string[]>`. It
 *     observes how the code actually behaves once a candidate is applied — the
 *     grounded observation.
 *   - revise: re-rank each diagnostic's completions by how much each one
 *     reduces the number of compiler-observed flaws, so a completion that
 *     actually compiles cleaner is surfaced first and one that introduces new
 *     compiler errors is demoted — even if the model scored it highly.
 *
 * Both the feedback (compiler diagnostics after applying a candidate) and the
 * metric (flaw-count delta vs the unmodified artifact) come from the same
 * compiler instrument, which is what the paper's grounding requirement asks
 * for. The pass is bounded by `maxInstrumentCalls` so the editor never pays an
 * unbounded cost for this third axis of test-time compute.
 *
 * Target-native substitutions (Mode 2):
 *   - The paper's bespoke proposer/reviewer LLM harness is replaced by the
 *     repo's existing `getAssistantDiagnostics` proposer and
 *     `getCompilerDiagnostics` instrument; no model is trained or added.
 *   - The paper's separate benchmark / eval framework is cut — evaluation
 *     belongs in a downstream PR.
 *   - "Revise" is implemented as re-ranking rather than discarding, so the IDE
 *     keeps every candidate fix but orders them by grounded evidence.
 */

/** External instrument contract — matches `getCompilerDiagnostics`. */
export type CompileInstrument = (
  code: string,
  fileName: string
) => Promise<string[]>;

export interface GroundedReorderOptions {
  /** Max candidate completions validated per diagnostic. Default 2. */
  maxCompletionsPerDiagnostic?: number;
  /** Total instrument calls allowed for the whole pass. Default 6. */
  maxInstrumentCalls?: number;
}

export const DEFAULT_MAX_COMPLETIONS_PER_DIAGNOSTIC = 2;
export const DEFAULT_MAX_INSTRUMENT_CALLS = 6;

/**
 * Splice a candidate completion into the full source at the diagnostic's
 * range, returning the code as it would look if the candidate were applied.
 * Pure; performs no I/O and does not mutate its inputs.
 */
export function applyCompletion(
  code: string,
  diagnostic: AssistantDiagnostic,
  completion: Completion
): string {
  const { start, end } = diagnostic.range;
  return `${code.slice(0, start)}${completion.value}${code.slice(end)}`;
}

/**
 * Bounded propose -> instrument -> revise pass.
 *
 * For each diagnostic with more than one candidate completion, validates (up
 * to) `maxCompletionsPerDiagnostic` candidates by applying them and asking the
 * instrument how many compiler flaws remain, then re-ranks the completion list
 * by flaw reduction (higher is better), tie-broken by the original model
 * score. Unvalidated candidates are treated as neutral (reduction 0), so a
 * candidate the compiler says makes things worse sinks below them. The total
 * number of instrument calls — including one baseline observation of the
 * unmodified code — is capped by `maxInstrumentCalls`; once the budget is spent,
 * remaining diagnostics keep their original order.
 *
 * Returns fresh `AssistantDiagnostic` objects with reordered completion lists;
 * the input array and its diagnostics are not mutated.
 */
export async function groundedReorder(
  code: string,
  fileName: string,
  diagnostics: AssistantDiagnostic[],
  instrument: CompileInstrument,
  options?: GroundedReorderOptions
): Promise<AssistantDiagnostic[]> {
  const maxPerDiagnostic =
    options?.maxCompletionsPerDiagnostic ??
    DEFAULT_MAX_COMPLETIONS_PER_DIAGNOSTIC;
  const budget = options?.maxInstrumentCalls ?? DEFAULT_MAX_INSTRUMENT_CALLS;

  if (diagnostics.length === 0 || budget <= 0) {
    return diagnostics;
  }

  // Baseline grounded observation: flaws in the unmodified artifact.
  const baselineFlaws = (await instrument(code, fileName)).length;
  const candidateBudget = budget - 1;

  type Job = {
    diagnosticIndex: number;
    completion: Completion;
    revisedCode: string;
  };
  type JobResult = Job & { flaws: number };

  // Collect the bounded set of (diagnostic, candidate) pairs to validate. The
  // global instrument-call budget caps how many candidates are observed across
  // the whole pass; once it is spent, remaining diagnostics keep their order.
  let remaining = candidateBudget;
  const jobs: Job[] = [];
  diagnostics.forEach((diagnostic, diagnosticIndex) => {
    if (remaining <= 0) {
      return;
    }
    const candidates = diagnostic.completionList;
    if (candidates.length < 2) {
      return;
    }
    const take = Math.min(maxPerDiagnostic, remaining);
    candidates.slice(0, take).forEach((completion) => {
      jobs.push({
        diagnosticIndex,
        completion,
        revisedCode: applyCompletion(code, diagnostic, completion),
      });
    });
    remaining -= take;
  });

  // Observe each candidate against the instrument. The observations are
  // independent, so they run as one Promise.all rather than serial awaits —
  // the budget bounds the interaction, it does not require serializing it.
  const results: JobResult[] = await Promise.all(
    jobs.map(
      async (job): Promise<JobResult> => {
        const flaws = (await instrument(job.revisedCode, fileName)).length;
        return { ...job, flaws };
      }
    )
  );

  const reductionsByDiagnostic = new Map<number, Map<Completion, number>>();
  results.forEach(({ diagnosticIndex, completion, flaws }) => {
    let reductionOf = reductionsByDiagnostic.get(diagnosticIndex);
    if (!reductionOf) {
      reductionOf = new Map<Completion, number>();
      reductionsByDiagnostic.set(diagnosticIndex, reductionOf);
    }
    reductionOf.set(completion, baselineFlaws - flaws);
  });

  return diagnostics.map((diagnostic, diagnosticIndex) => {
    const reductionOf = reductionsByDiagnostic.get(diagnosticIndex);
    if (!reductionOf) {
      return diagnostic; // single candidate, or budget exhausted before this one
    }
    const reorderedCompletionList = [...diagnostic.completionList].sort(
      (a, b) => {
        const reductionA = reductionOf.get(a) ?? 0;
        const reductionB = reductionOf.get(b) ?? 0;
        if (reductionA !== reductionB) {
          return reductionB - reductionA; // greater flaw reduction first
        }
        return b.score - a.score; // tie-break: original model score
      }
    );
    return { ...diagnostic, completionList: reorderedCompletionList };
  });
}
