/**
 * `@setupguard/adapter-node` — Node.js / JavaScript / TypeScript adapter.
 *
 * Everything ecosystem-specific lives here: manifest parsing, lockfile and
 * package-manager conventions, `.env` templates, and Markdown command
 * extraction. The core knows none of it.
 */

export { nodeAdapter, nodeChecks } from './adapter.js';

export { collectNodeFacts, type NodeFacts, type DocumentFacts } from './facts/collect.js';

export {
  parseDotenvKeys,
  mergeLocalKeys,
  AMBIENT_ENV_VARS,
  ENV_EXAMPLE_FILES,
  ENV_LOCAL_FILES,
  type DotenvEntry,
  type DotenvFile,
  type LocalKeyState,
} from './facts/dotenv.js';

export {
  scanEnvUsage,
  groupUsagesByName,
  SOURCE_EXTENSIONS,
  type EnvScanResult,
  type EnvUsage,
} from './facts/env-usage.js';

export { maskComments } from './facts/mask-comments.js';

export {
  describeGaps,
  gapsFor,
  hasGap,
  FACT_SCOPES,
  type FactGap,
  type FactScope,
} from './facts/gaps.js';

export {
  extractDocumentedCommands,
  ROOT_DOC_FILES,
  type DocumentedCommand,
} from './facts/markdown.js';

export {
  buildRequirement,
  findConflicts,
  resolvedRequirements,
  toRange,
  unsatisfied,
  type NodeVersionRequirement,
  type NodeVersionSource,
} from './facts/node-version.js';

export {
  LOCKFILES,
  PACKAGE_MANAGERS,
  PACKAGE_MANAGER_BUILTINS,
  LIFECYCLE_SHORTCUTS,
  isPackageManagerName,
  type PackageManagerName,
} from './facts/package-manager.js';

export {
  readEnginesNode,
  readPackageManagerField,
  readScripts,
  readVoltaNode,
  type PackageJson,
  type PackageJsonState,
} from './facts/package-json.js';

export {
  parseScriptReferences,
  type ScriptReference,
} from './facts/script-references.js';

export {
  findNestedProjectDirs,
  isInsideNestedProject,
  MAX_NESTED_PROJECT_MANIFESTS,
  type NestedProjectScan,
} from './facts/workspace-boundary.js';

export { packageJsonCheck } from './checks/package-json.js';
export { packageManagerAvailableCheck, packageManagerCheck } from './checks/package-manager.js';
export { nodeVersionDeclarationCheck, nodeVersionRuntimeCheck } from './checks/node-version.js';
export { scriptsCheck } from './checks/scripts.js';
export { envContractCheck, envLocalFileCheck } from './checks/env-contract.js';
export { docsScriptDriftCheck } from './checks/docs-drift.js';
