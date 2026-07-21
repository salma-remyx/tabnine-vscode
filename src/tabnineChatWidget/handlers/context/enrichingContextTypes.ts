export type EditorContext = {
  fileCode: string;
  currentLineIndex?: number;
};

export type WorkspaceContext = {
  symbols?: string[];
};

export type DiagnosticItem = {
  errorMessage: string;
  lineNumber: number;
  lineCode: string;
};

export type DiagnosticsContext = {
  diagnostics: DiagnosticItem[];
};

export type AnnotationItem = {
  // Human-readable text of the line-anchored comment (marker stripped).
  comment: string;
  // 1-indexed line number the comment is anchored to.
  lineNumber: number;
  // The source line carrying the comment, trimmed (anchor context).
  lineCode: string;
  // Optional review marker if present, e.g. "TODO" / "FIXME" / "NOTE".
  marker?: string;
};

export type InlineAnnotationsContext = {
  annotations: AnnotationItem[];
};

export type EnrichingContextTypes =
  | "Editor"
  | "Workspace"
  | "Diagnostics"
  | "InlineAnnotations";

export type ContextTypeData =
  | ({ type: "Editor" } & EditorContext)
  | ({
      type: "Diagnostics";
    } & DiagnosticsContext)
  | ({ type: "Workspace" } & WorkspaceContext)
  | ({
      type: "InlineAnnotations";
    } & InlineAnnotationsContext);
