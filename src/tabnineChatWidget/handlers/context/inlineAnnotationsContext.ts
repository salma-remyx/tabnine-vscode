import * as vscode from "vscode";
import { AnnotationItem, ContextTypeData } from "./enrichingContextTypes";

// Adapted from "Line-Anchored Feedback Cuts Token Costs and Improves
// Correctness in AI Code Editing" (arxiv 2607.12713). The paper shows that
// delivering requested changes as structured, line-anchored feedback (each
// note tied to a specific line) cuts generated tokens and raises correctness
// versus a holistic prompt. This module gathers a developer's line-anchored
// comment annotations from the active document and exports them as structured
// InlineAnnotations context for the chat backend to consume.
//
// Mode 2 (adapted port): the paper's core mechanism — collect line-anchored
// comments and export them as structured, line-numbered data — is kept at full
// fidelity. The paper's bespoke delivery surface (the FileMark VSCodium
// extension for inline comments, whose source is not published) is substituted
// with the editor's native, always-available surface: comment annotations
// already written in the document (TODO/FIXME/NOTE/review comments). VSCode
// exposes no stable API to enumerate another extension's comment threads, so
// document text is the robust source. The paper's separate R/benchmark
// analysis is intentionally out of scope (evaluation belongs downstream).

export type ParsedAnnotation = {
  comment: string;
  marker?: string;
};

export type LineRange = {
  startLine: number;
  endLineExclusive: number;
};

// Review markers recognized at the start of a comment. Kept as the single
// source of truth from which the detection pattern is built.
export const ANNOTATION_MARKERS = [
  "TODO",
  "FIXME",
  "NOTE",
  "REVIEW",
  "HACK",
  "XXX",
  "BUG",
  "OPTIMIZE",
] as const;

const FULL_LINE_INTRODUCERS = ["//", "#", "--"] as const;

// Matches an optional run of leading decoratives, then a known marker at the
// start of the comment text. Built from ANNOTATION_MARKERS so the list stays
// the single source of truth.
const LEADING_MARKER_PATTERN = new RegExp(
  `^[\\s\\[\\(\\{!<-]*(${ANNOTATION_MARKERS.join("|")})\\b`,
  "i"
);

export default async function getInlineAnnotationsContext(
  editor: vscode.TextEditor
): Promise<ContextTypeData | undefined> {
  const annotations = scanInlineAnnotations(
    (lineIndex) => editor.document.lineAt(lineIndex).text,
    editor.document.lineCount,
    editorLineRanges(editor)
  );
  if (!annotations.length) return Promise.resolve(undefined);

  return Promise.resolve({
    type: "InlineAnnotations",
    annotations,
  });
}

/**
 * Collect structured, line-anchored annotations from the in-scope lines of a
 * document. Pure (no vscode dependency): callers pass a line accessor, the
 * document line count, and the line ranges to scan.
 */
export function scanInlineAnnotations(
  getLineText: (zeroBasedLine: number) => string,
  lineCount: number,
  ranges: ReadonlyArray<LineRange>
): AnnotationItem[] {
  const lineIndices = collectLineIndices(ranges);

  const annotations: AnnotationItem[] = [];
  lineIndices.forEach((lineIndex) => {
    if (lineIndex < 0 || lineIndex >= lineCount) return;
    const lineText = getLineText(lineIndex);
    const parsed = parseAnnotation(lineText);
    if (!parsed) return;
    annotations.push({
      comment: parsed.comment,
      lineNumber: lineIndex + 1,
      lineCode: lineText.trim(),
      ...(parsed.marker ? { marker: parsed.marker } : {}),
    });
  });
  return annotations;
}

/**
 * Parse a single source line into a line-anchored annotation, or return
 * undefined when the line carries no comment.
 */
export function parseAnnotation(lineText: string): ParsedAnnotation | undefined {
  const commentText = extractComment(lineText);
  if (!commentText) return undefined;

  const { comment, marker } = stripLeadingMarker(commentText);
  const trimmed = comment.trim();
  if (!trimmed) return undefined;
  return marker ? { comment: trimmed, marker } : { comment: trimmed };
}

function editorLineRanges(editor: vscode.TextEditor): LineRange[] {
  const { selection } = editor;
  if (!selection.isEmpty) {
    return [
      {
        startLine: selection.start.line,
        endLineExclusive: selection.end.line + 1,
      },
    ];
  }
  return editor.visibleRanges.map((range) => ({
    startLine: range.start.line,
    endLineExclusive: range.end.line + 1,
  }));
}

function extractComment(lineText: string): string | undefined {
  const trimmed = lineText.trim();
  if (!trimmed) return undefined;

  // Inline block comment occupying the line: /* ... */
  const blockMatch = /\/\*([^*]*)\*\/\s*$/.exec(trimmed);
  if (blockMatch) {
    return blockMatch[1].trim() || undefined;
  }

  // Full-line comments introduced by a known prefix.
  const introducer = FULL_LINE_INTRODUCERS.find((prefix) =>
    trimmed.startsWith(prefix)
  );
  if (introducer) {
    const rest = trimmed
      .slice(introducer.length)
      .replace(/^[\s:]+/, "")
      .trim();
    return rest || undefined;
  }

  // Multi-line/HTML block comment spanning the whole line.
  if (trimmed.startsWith("<!--") && trimmed.endsWith("-->")) {
    return trimmed.slice(4, -3).trim() || undefined;
  }

  // Trailing comment after code. The [^:] guard avoids treating the "//" in a
  // URL scheme such as "https://" as a comment introducer.
  const trailing = /(^|[^:])\/\/[ \t]*(.*)$/.exec(trimmed);
  if (trailing && trailing[2].trim()) {
    return trailing[2].trim();
  }

  return undefined;
}

function stripLeadingMarker(commentText: string): ParsedAnnotation {
  const match = LEADING_MARKER_PATTERN.exec(commentText);
  if (!match) return { comment: commentText };
  const marker = match[1].toUpperCase();
  const afterMarker = commentText
    .slice(match[0].length)
    .replace(/^[\s:)-]+/, "");
  return { comment: afterMarker, marker };
}

function integersBetween(start: number, end: number): number[] {
  const lower = Math.max(start, 0);
  const upper = Math.max(end, 0);
  const values: number[] = [];
  for (let i = lower; i < upper; i += 1) {
    values.push(i);
  }
  return values;
}

function collectLineIndices(ranges: ReadonlyArray<LineRange>): number[] {
  const seen = new Set<number>();
  ranges.forEach((range) => {
    integersBetween(range.startLine, range.endLineExclusive).forEach((line) => {
      seen.add(line);
    });
  });
  return [...seen].sort((a, b) => a - b);
}
