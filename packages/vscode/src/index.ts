/**
 * `@setupguard/vscode` — editor presentation layer.
 *
 * Status in v0.1: the projection from a core report to editor diagnostics is
 * implemented and tested; the extension manifest, activation events, views and
 * commands are not. This package intentionally has no `vscode` dependency yet,
 * so it stays testable in plain Node.
 */

export {
  toDiagnostics,
  DIAGNOSTIC_SEVERITY,
  type DiagnosticPosition,
  type DiagnosticRange,
  type DiagnosticSeverity,
  type DiagnosticsProjection,
  type EditorDiagnostic,
} from './diagnostics.js';
