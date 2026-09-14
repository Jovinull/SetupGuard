import type { Adapter, Check, DiscoveryContext } from '@setupguard/core';

import { docsScriptDriftCheck } from './checks/docs-drift.js';
import { envContractCheck, envLocalFileCheck } from './checks/env-contract.js';
import { nodeVersionDeclarationCheck, nodeVersionRuntimeCheck } from './checks/node-version.js';
import { packageJsonCheck } from './checks/package-json.js';
import { packageManagerAvailableCheck, packageManagerCheck } from './checks/package-manager.js';
import { scriptsCheck } from './checks/scripts.js';
import { collectNodeFacts, type NodeFacts } from './facts/collect.js';
import { LOCKFILES } from './facts/package-manager.js';

/**
 * Files that make a directory recognisably a Node.js project.
 *
 * `package.json` is not required: a repository that lost its manifest but still
 * has a lockfile is exactly the broken state `node/package-json` must report.
 */
const DETECTION_FILES: readonly string[] = [
  'package.json',
  ...LOCKFILES.map((lockfile) => lockfile.file),
  '.nvmrc',
  '.node-version',
  'tsconfig.json',
];

/** Checks contributed by this adapter, in reporting order (static first). */
export const nodeChecks: readonly Check<NodeFacts>[] = [
  packageJsonCheck,
  packageManagerCheck,
  nodeVersionDeclarationCheck,
  scriptsCheck,
  envContractCheck,
  docsScriptDriftCheck,
  packageManagerAvailableCheck,
  nodeVersionRuntimeCheck,
  envLocalFileCheck,
];

/** The Node.js / JavaScript / TypeScript adapter. */
export const nodeAdapter: Adapter<NodeFacts> = {
  id: 'node',
  name: 'Node.js',
  async detect({ fs }: DiscoveryContext): Promise<boolean> {
    for (const file of DETECTION_FILES) {
      if (await fs.isFile(file)) return true;
    }
    return false;
  },
  collect: collectNodeFacts,
  checks: nodeChecks,
};
