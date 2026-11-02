/** Module surface used by the tests. The shipped artifact is `dist/index.cjs`, built from `main.ts`. */
export { analyse, decideFull, decidePullRequest, isUsableRepoPath, MAX_FILE_BYTES, type Analysis } from './analyse.js';
export { BaseWorkspaceFs, walkOrder } from './base-fs.js';
export { compareReports, fingerprint, type ClassifiedFinding, type Comparison } from './compare.js';
export { parseRepository, readCheckedOutSha, readInputs, readRunContext, resolveAnalysisRoot } from './context.js';
export { GitHubApiError, GitHubClient, type ApiCall, type FetchLike } from './github-api.js';
export { getContentAt, listPullRequestFiles, type BaseEntry } from './pull-request.js';
export { buildAnnotations, buildOutputs, escapeHtml, renderLog, renderSummary } from './render.js';
export { runAction, type ActionIo } from './run.js';
export { escapeData, escapeProperty, formatAnnotation, formatOutputs, inertBlock } from './workflow-commands.js';
