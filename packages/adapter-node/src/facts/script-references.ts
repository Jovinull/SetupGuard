import {
  LIFECYCLE_SHORTCUTS,
  PACKAGE_MANAGER_BUILTINS,
  isPackageManagerName,
  type PackageManagerName,
} from './package-manager.js';

/** A package script named by a command line. */
export interface ScriptReference {
  readonly script: string;
  readonly manager: PackageManagerName;
  /**
   * `high` when the command uses an explicit form (`npm run build`,
   * `npm test`); `medium` for the implicit form (`pnpm build`), which could
   * also be a package-manager sub-command SetupGuard does not know about.
   */
  readonly confidence: 'high' | 'medium';
  /** The sub-command the reference was parsed from, for evidence. */
  readonly raw: string;
}

/**
 * Flags that point the command at a *different* package than the one being
 * analysed.
 *
 * When one of these appears anywhere in the command, the script name that
 * follows belongs to another manifest, and resolving it against this
 * `package.json` produces a confident, blocking, and wrong finding:
 * `npm --prefix ./sub run build` was reported as a missing script even though
 * `sub/package.json` declares it.
 *
 * There is no cheap way to resolve the target manifest at this level, so the
 * reference is dropped instead. Precision over coverage: a missed drift costs
 * far less than a false blocker.
 */
const WORKSPACE_REDIRECT_FLAGS: ReadonlySet<string> = new Set([
  '--cwd',
  '--dir',
  '--filter',
  '--filter-prod',
  '-F',
  '--prefix',
  '-C',
  '--recursive',
  '-r',
  '--workspace',
  '-w',
  '-W',
  '--workspaces',
  '--ws',
]);

/** Flags that consume the following token, so it is not mistaken for a script. */
const FLAGS_WITH_VALUE: ReadonlySet<string> = new Set([
  ...WORKSPACE_REDIRECT_FLAGS,
  '--if-present-only',
  '--reporter',
]);

/** Shell operators that separate independent commands. */
const SEPARATORS = /\s*(?:&&|\|\||;|\|)\s*/;

/** Characters that mark a token as a documentation placeholder, not a real name. */
const PLACEHOLDER = /[<>{}$*()[\]"'`\\]/;

/**
 * Extract the package scripts referenced by a command line.
 *
 * Used for two different inputs with the same grammar: the body of a
 * `package.json` script, and a shell command found in Markdown.
 */
export function parseScriptReferences(commandLine: string): ScriptReference[] {
  const references: ScriptReference[] = [];

  for (const segment of commandLine.split(SEPARATORS)) {
    const reference = parseSegment(segment);
    if (reference) references.push(reference);
  }

  return references;
}

function parseSegment(segment: string): ScriptReference | undefined {
  const raw = segment.trim();
  if (raw === '') return undefined;

  const tokens = tokenize(raw);
  let index = 0;

  // Drop a shell prompt marker and leading `sudo`.
  while (tokens[index] === '$' || tokens[index] === '>' || tokens[index] === 'sudo') index += 1;
  // Drop leading `KEY=value` environment assignments.
  while (tokens[index] !== undefined && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? '')) {
    index += 1;
  }

  const manager = tokens[index];
  if (manager === undefined || !isPackageManagerName(manager)) return undefined;
  index += 1;

  // Scan the whole segment first: a redirect flag can appear after the script
  // name (`npm run build --workspace=api`), so stopping at the first
  // non-flag token would miss it.
  if (tokens.slice(index).some(isWorkspaceRedirect)) return undefined;

  let explicitRun = false;
  for (; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) break;

    if (token.startsWith('-')) {
      if (FLAGS_WITH_VALUE.has(token)) index += 1;
      continue;
    }

    if (token === 'run' && !explicitRun) {
      explicitRun = true;
      continue;
    }

    return classify(manager, token, explicitRun, raw);
  }

  return undefined;
}

function classify(
  manager: PackageManagerName,
  candidate: string,
  explicitRun: boolean,
  raw: string,
): ScriptReference | undefined {
  if (candidate === '' || PLACEHOLDER.test(candidate) || candidate.includes('/')) return undefined;

  if (explicitRun) {
    return { script: candidate, manager, confidence: 'high', raw };
  }

  if (LIFECYCLE_SHORTCUTS.has(candidate)) {
    return { script: candidate, manager, confidence: 'high', raw };
  }

  if (PACKAGE_MANAGER_BUILTINS.has(candidate)) return undefined;

  // npm requires `npm run <script>`; a bare unknown sub-command is not a script
  // reference, so reporting it would be a false positive.
  if (manager === 'npm') return undefined;

  return { script: candidate, manager, confidence: 'medium', raw };
}

/** True for `--filter`, `-C`, `--workspace=api` and friends. */
function isWorkspaceRedirect(token: string): boolean {
  if (!token.startsWith('-')) return false;
  const name = token.split('=', 1)[0] ?? token;
  return WORKSPACE_REDIRECT_FLAGS.has(name);
}

/** Whitespace tokenizer that keeps quoted segments together. */
function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: string | undefined;

  for (const char of input) {
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current !== '') tokens.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current !== '') tokens.push(current);
  return tokens;
}
