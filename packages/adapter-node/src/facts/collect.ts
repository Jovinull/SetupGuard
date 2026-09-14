import { describeJsonParseError, type DiscoveryContext } from '@setupguard/core';

import {
  ENV_EXAMPLE_FILES,
  ENV_LOCAL_FILES,
  mergeLocalKeys,
  parseDotenvKeys,
  type DotenvFile,
  type LocalKeyState,
} from './dotenv.js';
import { scanEnvUsage, type EnvUsage } from './env-usage.js';
import type { FactGap, FactScope } from './gaps.js';
import { extractDocumentedCommands, ROOT_DOC_FILES, type DocumentedCommand } from './markdown.js';
import { buildRequirement, type NodeVersionRequirement } from './node-version.js';
import { LOCKFILES, isPackageManagerName, type PackageManagerName } from './package-manager.js';
import {
  readEnginesNode,
  readPackageManagerField,
  readScripts,
  readVoltaNode,
  type PackageJson,
  type PackageJsonState,
} from './package-json.js';
import { findNestedProjectDirs } from './workspace-boundary.js';

export interface LockfilePresence {
  readonly file: string;
  readonly manager: PackageManagerName;
}

export interface DeclaredPackageManager {
  readonly name: PackageManagerName;
  readonly version?: string;
  readonly source: 'package.json#packageManager';
  readonly raw: string;
}

export interface DocumentFacts {
  readonly file: string;
  readonly commands: readonly DocumentedCommand[];
}

/** Everything the Node adapter reads once per run, shared by all its checks. */
export interface NodeFacts {
  readonly packageJson: PackageJsonState;
  /** Convenience view: the parsed manifest, or `undefined` when unusable. */
  readonly manifest?: PackageJson;
  readonly scripts: Record<string, string>;
  readonly lockfiles: readonly LockfilePresence[];
  readonly declaredPackageManager?: DeclaredPackageManager;
  readonly nodeVersionRequirements: readonly NodeVersionRequirement[];
  readonly envExampleFile?: DotenvFile;
  /** Every local environment file that exists, in load order. */
  readonly envLocalFiles: readonly DotenvFile[];
  /** Merged view of the local files: absent / empty / set, per variable. */
  readonly envLocalKeys: ReadonlyMap<string, LocalKeyState>;
  readonly envUsages: readonly EnvUsage[];
  readonly documents: readonly DocumentFacts[];
  /**
   * Directories holding their own `package.json`. Source scans stop at these
   * boundaries so a nested project's code is not attributed to this one.
   */
  readonly nestedProjectDirs: readonly string[];
  /**
   * Everything that could not be read, or could not be read fully. Checks whose
   * scope is affected must report `inconclusive` rather than a clean result.
   */
  readonly gaps: readonly FactGap[];
}

export async function collectNodeFacts({ fs }: DiscoveryContext): Promise<NodeFacts> {
  const gaps: FactGap[] = [];
  const packageJson = await loadPackageJson(fs, gaps);
  const manifest = packageJson.kind === 'ok' ? packageJson.data : undefined;

  const lockfiles: LockfilePresence[] = [];
  for (const lockfile of LOCKFILES) {
    if (await fs.isFile(lockfile.file)) {
      lockfiles.push({ file: lockfile.file, manager: lockfile.manager });
    }
  }

  const declaredPackageManager = manifest ? readDeclaredPackageManager(manifest) : undefined;
  const nodeVersionRequirements = await collectNodeVersionRequirements(fs, manifest, gaps);

  const envExampleFile = await loadFirstDotenv(fs, ENV_EXAMPLE_FILES, 'env-template', gaps);
  const envLocalFiles = await loadAllDotenv(fs, ENV_LOCAL_FILES, 'env-local', gaps);

  const nested = await findNestedProjectDirs(fs);
  gaps.push(...nested.gaps);
  const envScan = await scanEnvUsage(fs, { excludeDirs: nested.dirs });
  gaps.push(...envScan.gaps);

  const documents = await collectDocuments(fs, gaps);

  return {
    packageJson,
    manifest,
    scripts: manifest ? readScripts(manifest) : {},
    lockfiles,
    declaredPackageManager,
    nodeVersionRequirements,
    envExampleFile,
    envLocalFiles,
    envLocalKeys: mergeLocalKeys(envLocalFiles),
    envUsages: envScan.usages,
    documents,
    nestedProjectDirs: nested.dirs,
    gaps,
  };
}

async function loadPackageJson(
  fs: DiscoveryContext['fs'],
  gaps: FactGap[],
): Promise<PackageJsonState> {
  if (!(await fs.isFile('package.json'))) return { kind: 'missing' };

  let raw: string;
  try {
    raw = await fs.readText('package.json');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    gaps.push({ scope: 'package.json', file: 'package.json', reason: message });
    return { kind: 'unreadable', error: message };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    // Never keep the native message: V8 quotes the first characters of the
    // input back at you, and a malformed manifest can begin with a credential.
    const described = describeJsonParseError(error);
    return {
      kind: 'invalid',
      error: described.message,
      ...(described.line !== undefined ? { line: described.line } : {}),
      ...(described.column !== undefined ? { column: described.column } : {}),
      raw,
    };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { kind: 'not-an-object', raw };
  }

  return { kind: 'ok', data: parsed, raw };
}

function readDeclaredPackageManager(manifest: PackageJson): DeclaredPackageManager | undefined {
  const field = readPackageManagerField(manifest);
  if (!field || !isPackageManagerName(field.name)) return undefined;
  const raw = typeof manifest.packageManager === 'string' ? manifest.packageManager : field.name;
  return field.version === undefined
    ? { name: field.name, source: 'package.json#packageManager', raw }
    : { name: field.name, version: field.version, source: 'package.json#packageManager', raw };
}

async function collectNodeVersionRequirements(
  fs: DiscoveryContext['fs'],
  manifest: PackageJson | undefined,
  gaps: FactGap[],
): Promise<NodeVersionRequirement[]> {
  const requirements: NodeVersionRequirement[] = [];

  if (manifest) {
    const engines = readEnginesNode(manifest);
    if (engines !== undefined && engines.trim() !== '') {
      requirements.push(buildRequirement('package.json#engines.node', 'package.json', engines));
    }
    const volta = readVoltaNode(manifest);
    if (volta !== undefined && volta.trim() !== '') {
      requirements.push(buildRequirement('package.json#volta.node', 'package.json', volta));
    }
  }

  for (const [file, source] of [
    ['.nvmrc', '.nvmrc'],
    ['.node-version', '.node-version'],
  ] as const) {
    if (!(await fs.isFile(file))) continue;
    try {
      const content = (await fs.readText(file)).trim();
      if (content !== '') requirements.push(buildRequirement(source, file, content));
    } catch (error) {
      gaps.push({
        scope: 'node-version',
        file,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return requirements;
}

async function loadFirstDotenv(
  fs: DiscoveryContext['fs'],
  candidates: readonly string[],
  scope: FactScope,
  gaps: FactGap[],
): Promise<DotenvFile | undefined> {
  for (const candidate of candidates) {
    if (!(await fs.isFile(candidate))) continue;
    try {
      return parseDotenvKeys(candidate, await fs.readText(candidate));
    } catch (error) {
      gaps.push({
        scope,
        file: candidate,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return undefined;
}

async function loadAllDotenv(
  fs: DiscoveryContext['fs'],
  candidates: readonly string[],
  scope: FactScope,
  gaps: FactGap[],
): Promise<DotenvFile[]> {
  const files: DotenvFile[] = [];
  for (const candidate of candidates) {
    if (!(await fs.isFile(candidate))) continue;
    try {
      files.push(parseDotenvKeys(candidate, await fs.readText(candidate)));
    } catch (error) {
      gaps.push({
        scope,
        file: candidate,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return files;
}

async function collectDocuments(
  fs: DiscoveryContext['fs'],
  gaps: FactGap[],
): Promise<DocumentFacts[]> {
  const walked = await fs.walk({ dir: 'docs', extensions: ['.md'], maxDepth: 3, maxFiles: 50 });
  if (walked.truncated) {
    gaps.push({
      scope: 'documents',
      reason: 'the docs/ scan hit its file limit, so some documentation was not checked',
    });
  }
  if (walked.depthLimited) {
    gaps.push({
      scope: 'documents',
      reason: 'docs/ is deeper than the scan limit, so some documentation was not checked',
    });
  }

  const candidates = [...new Set([...ROOT_DOC_FILES, ...walked.files])];
  const documents: DocumentFacts[] = [];
  // `README.md` and `readme.md` are the same file on a case-insensitive
  // filesystem; scanning both would duplicate every finding.
  const seen = new Set<string>();

  for (const file of candidates) {
    const key = file.toLowerCase();
    if (seen.has(key)) continue;
    if (!(await fs.isFile(file))) continue;
    seen.add(key);
    try {
      const text = await fs.readText(file);
      documents.push({ file, commands: extractDocumentedCommands(text) });
    } catch (error) {
      gaps.push({
        scope: 'documents',
        file,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return documents;
}
