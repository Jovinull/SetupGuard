/**
 * `setupguard` — the VS Code extension.
 *
 * This entry point exports only the parts that do not touch the `vscode`
 * module: the projection from a report to editor diagnostics, the session
 * lifecycle, the status bar derivation, the report rendering and the watch
 * list. They are the layer where the decisions live, and they are testable in
 * plain Node.
 *
 * `src/extension.ts` is the extension host entry point declared in
 * `package.json`. It is deliberately not re-exported here: importing it outside
 * an Extension Host would fail on the `vscode` module.
 */

export {
  toDiagnostics,
  toConfigDiagnostics,
  CONFIG_CHECK_ID,
  DIAGNOSTIC_SEVERITY,
  type DiagnosticPosition,
  type DiagnosticRange,
  type DiagnosticSeverity,
  type DiagnosticsProjection,
  type EditorDiagnostic,
} from './diagnostics.js';

export {
  DiagnosisSession,
  type CancelScheduled,
  type DiagnosisPhase,
  type SessionOptions,
  type SessionState,
} from './session.js';

export {
  summarise,
  toStatusBarState,
  SHOW_REPORT_COMMAND,
  type AggregateSummary,
  type StatusBarState,
  type StatusInput,
} from './status.js';

export { renderReport, renderReports, type RenderReportOptions } from './report-view.js';

export {
  shouldTriggerRun,
  DOCUMENT_GLOBS,
  SOURCE_GLOBS,
  STRUCTURAL_FILES,
  WATCH_GLOBS,
} from './watch-patterns.js';
