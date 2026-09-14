/**
 * `@setupguard/core` — interface-agnostic diagnosis engine.
 *
 * The core knows how to run adapters and turn their findings into a report. It
 * knows nothing about Node, npm, Markdown, VS Code or GitHub: those live in
 * adapters and interface packages.
 */

export {
  REPORT_SCHEMA_VERSION,
  VERIFICATION_LEVELS,
  DEFAULT_LEVELS,
  CATEGORIES,
  allFindings,
  type AdapterReport,
  type Category,
  type CheckResult,
  type CheckStatus,
  type Confidence,
  type Evidence,
  type Finding,
  type FindingInput,
  type Readiness,
  type Report,
  type ReportSummary,
  type Severity,
  type VerificationLevel,
} from './model/types.js';

export {
  DEFAULT_IGNORED_DIRS,
  FileTooLargeError,
  WorkspaceBoundaryError,
  type WalkOptions,
  type WalkResult,
  type WorkspaceFs,
} from './fs/workspace-fs.js';
export { NodeWorkspaceFs, type NodeWorkspaceFsOptions } from './fs/node-workspace-fs.js';

export type { EnvironmentProbe } from './env/environment.js';
export { NodeEnvironmentProbe, type NodeEnvironmentProbeOptions } from './env/node-environment.js';

export {
  found,
  inconclusive,
  notApplicable,
  pass,
  type Adapter,
  type AnyAdapter,
  type Check,
  type CheckContext,
  type CheckOutput,
  type DiscoveryContext,
} from './adapter/adapter.js';
export { AdapterRegistry } from './adapter/registry.js';

export {
  runDiagnosis,
  DEFAULT_CHECK_TIMEOUT_MS,
  DEFAULT_ADAPTER_TIMEOUT_MS,
  type RunOptions,
} from './engine/run.js';
export {
  aggregateReadiness,
  incompleteReason,
  statusFromFindings,
  summarize,
} from './engine/aggregate.js';
export { sanitizeEvidence, sanitizeFinding, sanitizeResult } from './engine/sanitize.js';

export { reportToJson } from './report/serialize.js';

export { offsetToPosition, lineAt, excerpt, type TextPosition } from './util/text-position.js';
export { locateJsonKey, type JsonLocation } from './util/json-source.js';
export { closestMatch, editDistance } from './util/similar.js';
export {
  redact,
  redactOptional,
  redactPath,
  redactPathOptional,
  describeError,
  describeJsonParseError,
  MAX_FIELD_LENGTH,
  MAX_PATH_LENGTH,
  REDACTED,
} from './util/redact.js';
