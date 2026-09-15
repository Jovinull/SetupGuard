import { isAlias, parseDocument, visit, type Document } from 'yaml';

import type { WorkspaceFs } from '../fs/workspace-fs.js';
import { offsetToPosition } from '../util/text-position.js';
import { redact } from '../util/redact.js';
import { normalizeIgnorePattern } from './ignore.js';
import {
  CONFIG_CHECK_KEYS,
  CONFIG_ENV_KEYS,
  CONFIG_FILE_NAME,
  CONFIG_TOP_LEVEL_KEYS,
  CONFIG_VERSION,
  ENV_VAR_NAME_PATTERN,
  MISNAMED_CONFIG_FILES,
  SEVERITY_OVERRIDES,
} from './schema.js';
import {
  DEFAULT_CONFIG,
  type ConfigDiagnostic,
  type ConfigDiagnosticCode,
  type ResolvedConfig,
  type SeverityOverride,
} from './types.js';

export interface LoadConfigOptions {
  readonly fs: WorkspaceFs;
  /**
   * Check ids the run knows about. An override naming anything else is
   * reported: a typo in a suppression silently suppresses nothing, which is
   * exactly the class of failure this tool exists to catch.
   */
  readonly knownCheckIds: readonly string[];
}

/**
 * Discover, parse, validate and normalise `.setupguard.yml` — the one place
 * that touches YAML.
 *
 * Never throws, and never returns a partially-applied configuration. When the
 * file cannot be used, the result carries `valid: false` plus diagnostics, and
 * the defaults so the run can still produce information.
 *
 * The whole body sits inside an error barrier because "never throws" is part of
 * the exported contract: a `WorkspaceFs` implementation that rejects — a
 * permission error on the directory, a custom implementation in a host
 * application — must not take the run down with it.
 */
export async function loadConfig(options: LoadConfigOptions): Promise<ResolvedConfig> {
  try {
    return await discoverAndLoad(options);
  } catch (error) {
    return invalid([
      diagnostic('config/unreadable', `${CONFIG_FILE_NAME} could not be inspected`, {
        remediation: redact(error instanceof Error ? error.message : String(error)),
      }),
    ]);
  }
}

async function discoverAndLoad(options: LoadConfigOptions): Promise<ResolvedConfig> {
  const { fs } = options;

  // Presence and usability are two different questions, and collapsing them
  // into `isFile()` made a `.setupguard.yml` that is a directory, a broken
  // symlink, or a symlink out of the workspace look exactly like no file at
  // all — silently dropping a configuration that may have been raising a
  // warning to an error. `listDir` reports the directory entry whatever it
  // points at, so the two questions can be asked separately.
  const present = (await fs.listDir('.')).includes(CONFIG_FILE_NAME);
  if (!present) return await noConfig(fs);

  if (!(await fs.isFile(CONFIG_FILE_NAME))) {
    return invalid([
      diagnostic('config/not-a-file', `${CONFIG_FILE_NAME} is not a readable regular file`, {
        remediation:
          'It must be a regular file inside the workspace. A directory, a broken symlink, or a link pointing outside the workspace cannot be used.',
      }),
    ]);
  }

  let text: string;
  try {
    text = await fs.readText(CONFIG_FILE_NAME);
  } catch (error) {
    return invalid([
      diagnostic('config/unreadable', `${CONFIG_FILE_NAME} could not be read`, {
        remediation: redact(error instanceof Error ? error.message : String(error)),
      }),
    ]);
  }

  return parseAndValidate(text, options.knownCheckIds);
}

/**
 * No configuration file. Still worth one look: a file named `.setupguard.yaml`
 * would otherwise be written, committed, and never loaded.
 */
async function noConfig(fs: WorkspaceFs): Promise<ResolvedConfig> {
  for (const candidate of MISNAMED_CONFIG_FILES) {
    if (await fs.isFile(candidate)) {
      return {
        ...DEFAULT_CONFIG,
        valid: false,
        diagnostics: [
          diagnostic(
            'config/misnamed-file',
            `Found ${candidate}, but SetupGuard only reads ${CONFIG_FILE_NAME}`,
            { file: candidate, remediation: `Rename ${candidate} to ${CONFIG_FILE_NAME}.` },
          ),
        ],
      };
    }
  }
  return DEFAULT_CONFIG;
}

function parseAndValidate(text: string, knownCheckIds: readonly string[]): ResolvedConfig {
  // `uniqueKeys` turns a repeated key into an error instead of letting the last
  // one silently win; `merge: false` keeps YAML merge keys out of the dialect.
  const doc = parseDocument(text, { uniqueKeys: true, merge: false });

  const syntax: ConfigDiagnostic[] = doc.errors.map((error) =>
    diagnostic('config/invalid-yaml', redact(firstLine(error.message)), {
      ...positionFromOffset(text, error.pos[0]),
    }),
  );
  // An unresolved tag is reported as a warning by the parser and degrades to a
  // plain value. Accepting it would mean accepting a document this dialect does
  // not actually understand.
  syntax.push(
    ...doc.warnings.map((warning) =>
      diagnostic('config/unsupported-syntax', redact(firstLine(warning.message)), {
        ...positionFromOffset(text, warning.pos[0]),
      }),
    ),
  );

  // Anchors *and* aliases are rejected. Alias expansion is the one part of YAML
  // that turns a small document into a very large one, and an anchor is how an
  // alias gets written — declaring the contract as "no anchors" while only
  // looking for aliases left `version: &release 1` quietly accepted.
  visit(doc, (_key, node) => {
    if (node === null || typeof node !== 'object') return;
    const anchored = node as { anchor?: string; range?: [number, number, number] };
    if (isAlias(node)) {
      syntax.push(
        diagnostic('config/unsupported-syntax', 'YAML aliases are not supported in configuration', {
          ...positionFromOffset(text, anchored.range?.[0]),
          remediation: 'Write the value out instead of referencing an anchor.',
        }),
      );
      return;
    }
    if (typeof anchored.anchor === 'string') {
      syntax.push(
        diagnostic('config/unsupported-syntax', 'YAML anchors are not supported in configuration', {
          ...positionFromOffset(text, anchored.range?.[0]),
          remediation: `Remove the "&${redact(anchored.anchor)}" anchor.`,
        }),
      );
    }
  });

  if (syntax.length > 0) return invalid(syntax);

  let raw: unknown;
  try {
    raw = doc.toJS({ maxAliasCount: 0 });
  } catch (error) {
    return invalid([
      diagnostic('config/invalid-yaml', redact(firstLine(String(error))), {}),
    ]);
  }

  return validate(raw, doc, text, knownCheckIds);
}

function validate(
  raw: unknown,
  doc: Document,
  text: string,
  knownCheckIds: readonly string[],
): ResolvedConfig {
  const diagnostics: ConfigDiagnostic[] = [];
  const at = (path: readonly (string | number)[]) => locate(doc, text, path);

  if (raw === null || raw === undefined) {
    return invalid([
      diagnostic('config/version-missing', `${CONFIG_FILE_NAME} is empty`, {
        remediation: `Add "version: ${CONFIG_VERSION}" or delete the file.`,
      }),
    ]);
  }

  if (!isPlainObject(raw)) {
    return invalid([
      diagnostic('config/not-an-object', `${CONFIG_FILE_NAME} must contain a mapping`, at([])),
    ]);
  }

  for (const key of Object.keys(raw)) {
    if (!CONFIG_TOP_LEVEL_KEYS.includes(key)) {
      diagnostics.push(
        diagnostic('config/unknown-key', `Unknown configuration key "${redact(key)}"`, {
          ...at([key]),
          path: key,
          remediation: `Known keys: ${CONFIG_TOP_LEVEL_KEYS.join(', ')}.`,
        }),
      );
    }
  }

  // --- version -------------------------------------------------------------
  if (!('version' in raw)) {
    diagnostics.push(
      diagnostic('config/version-missing', 'Configuration is missing "version"', {
        ...at([]),
        path: 'version',
        remediation: `Add "version: ${CONFIG_VERSION}" as the first line.`,
      }),
    );
  } else if (raw['version'] !== CONFIG_VERSION) {
    diagnostics.push(
      diagnostic(
        'config/version-unsupported',
        `Unsupported configuration version ${redact(String(raw['version']))}`,
        {
          ...at(['version']),
          path: 'version',
          remediation: `This release of SetupGuard reads version ${CONFIG_VERSION} only.`,
        },
      ),
    );
  }

  const checks = readChecks(raw['checks'], knownCheckIds, at, diagnostics);
  const optionalEnvVars = readEnv(raw['env'], at, diagnostics);
  const ignore = readIgnore(raw['ignore'], at, diagnostics);

  if (diagnostics.length > 0) return invalid(diagnostics);

  return {
    source: CONFIG_FILE_NAME,
    valid: true,
    checks,
    optionalEnvVars,
    ignore,
    diagnostics: [],
  };
}

type Locator = (path: readonly (string | number)[]) => Partial<ConfigDiagnostic>;

function readChecks(
  value: unknown,
  knownCheckIds: readonly string[],
  at: Locator,
  diagnostics: ConfigDiagnostic[],
): ReadonlyMap<string, SeverityOverride> {
  const result = new Map<string, SeverityOverride>();
  if (value === undefined) return result;

  if (!isPlainObject(value)) {
    diagnostics.push(
      diagnostic('config/wrong-type', '"checks" must be a mapping of check id to settings', {
        ...at(['checks']),
        path: 'checks',
      }),
    );
    return result;
  }

  for (const [id, setting] of Object.entries(value)) {
    if (!knownCheckIds.includes(id)) {
      diagnostics.push(
        diagnostic('config/unknown-check', `Unknown check id "${redact(id)}"`, {
          ...at(['checks', id]),
          path: `checks.${id}`,
          remediation: `Known checks: ${knownCheckIds.join(', ')}.`,
        }),
      );
      continue;
    }

    if (!isPlainObject(setting)) {
      diagnostics.push(
        diagnostic('config/wrong-type', `"checks.${redact(id)}" must be a mapping`, {
          ...at(['checks', id]),
          path: `checks.${id}`,
          remediation: `Known settings: ${CONFIG_CHECK_KEYS.join(', ')}.`,
        }),
      );
      continue;
    }

    for (const key of Object.keys(setting)) {
      if (!CONFIG_CHECK_KEYS.includes(key)) {
        diagnostics.push(
          diagnostic('config/unknown-key', `Unknown setting "${redact(key)}" for check "${redact(id)}"`, {
            ...at(['checks', id, key]),
            path: `checks.${id}.${key}`,
            remediation: `Known settings: ${CONFIG_CHECK_KEYS.join(', ')}.`,
          }),
        );
      }
    }

    const severity = setting['severity'];
    if (severity === undefined) continue;

    if (typeof severity !== 'string' || !SEVERITY_OVERRIDES.includes(severity as SeverityOverride)) {
      diagnostics.push(
        diagnostic('config/invalid-severity', `Invalid severity ${redact(JSON.stringify(severity) ?? 'undefined')}`, {
          ...at(['checks', id, 'severity']),
          path: `checks.${id}.severity`,
          remediation: `Use one of: ${SEVERITY_OVERRIDES.join(', ')}.`,
        }),
      );
      continue;
    }

    result.set(id, severity as SeverityOverride);
  }

  return result;
}

function readEnv(value: unknown, at: Locator, diagnostics: ConfigDiagnostic[]): ReadonlySet<string> {
  const result = new Set<string>();
  if (value === undefined) return result;

  if (!isPlainObject(value)) {
    diagnostics.push(
      diagnostic('config/wrong-type', '"env" must be a mapping', { ...at(['env']), path: 'env' }),
    );
    return result;
  }

  for (const key of Object.keys(value)) {
    if (!CONFIG_ENV_KEYS.includes(key)) {
      diagnostics.push(
        diagnostic('config/unknown-key', `Unknown key "${redact(key)}" under "env"`, {
          ...at(['env', key]),
          path: `env.${key}`,
          remediation: `Known keys: ${CONFIG_ENV_KEYS.join(', ')}.`,
        }),
      );
    }
  }

  const optional = value['optional'];
  if (optional === undefined) return result;

  if (!Array.isArray(optional)) {
    diagnostics.push(
      diagnostic('config/wrong-type', '"env.optional" must be a list of variable names', {
        ...at(['env', 'optional']),
        path: 'env.optional',
      }),
    );
    return result;
  }

  const namePattern = new RegExp(ENV_VAR_NAME_PATTERN);
  for (const [index, entry] of optional.entries()) {
    const path = `env.optional[${index}]`;
    if (typeof entry !== 'string' || !namePattern.test(entry)) {
      diagnostics.push(
        diagnostic(
          'config/invalid-env-name',
          `"${redact(String(entry))}" is not a valid environment variable name`,
          {
            ...at(['env', 'optional', index]),
            path,
            remediation: 'Use exact names such as SENTRY_DSN. Patterns are not supported.',
          },
        ),
      );
      continue;
    }
    if (result.has(entry)) {
      diagnostics.push(
        diagnostic('config/duplicate-entry', `"${redact(entry)}" is listed twice in env.optional`, {
          ...at(['env', 'optional', index]),
          path,
        }),
      );
      continue;
    }
    result.add(entry);
  }

  return result;
}

function readIgnore(value: unknown, at: Locator, diagnostics: ConfigDiagnostic[]): string[] {
  if (value === undefined) return [];

  if (!Array.isArray(value)) {
    diagnostics.push(
      diagnostic('config/wrong-type', '"ignore" must be a list of patterns', {
        ...at(['ignore']),
        path: 'ignore',
      }),
    );
    return [];
  }

  const patterns: string[] = [];
  for (const [index, entry] of value.entries()) {
    const path = `ignore[${index}]`;
    if (typeof entry !== 'string') {
      diagnostics.push(
        diagnostic('config/wrong-type', `"${path}" must be a string`, { ...at(['ignore', index]), path }),
      );
      continue;
    }

    const normalized = normalizeIgnorePattern(entry);
    if (normalized.error !== undefined || normalized.pattern === undefined) {
      diagnostics.push(
        diagnostic(
          'config/invalid-ignore-pattern',
          `Ignore pattern "${redact(entry)}" is ${describePatternError(normalized.error)}`,
          {
            ...at(['ignore', index]),
            path,
            remediation: 'Patterns must be relative to the workspace root and may use * and **.',
          },
        ),
      );
      continue;
    }

    if (patterns.includes(normalized.pattern)) {
      diagnostics.push(
        diagnostic('config/duplicate-entry', `Ignore pattern "${redact(entry)}" is listed twice`, {
          ...at(['ignore', index]),
          path,
        }),
      );
      continue;
    }
    patterns.push(normalized.pattern);
  }

  // Sorted so two runs of the same configuration produce the same order.
  return patterns.sort();
}

function describePatternError(error: string | undefined): string {
  switch (error) {
    case 'absolute':
      return 'an absolute path';
    case 'traversal':
      return 'escaping the workspace root';
    case 'negation':
      return 'a negation, which is not supported';
    case 'unsupported-syntax':
      return 'using syntax this dialect does not implement';
    default:
      return 'empty';
  }
}

/** Position of a node in the document, for pointing at the offending field. */
function locate(
  doc: Document,
  text: string,
  path: readonly (string | number)[],
): Partial<ConfigDiagnostic> {
  try {
    const node: unknown = path.length === 0 ? doc.contents : doc.getIn(path, true);
    const range = (node as { range?: [number, number, number] } | null)?.range;
    return positionFromOffset(text, range?.[0]);
  } catch {
    return {};
  }
}

function positionFromOffset(text: string, offset: number | undefined): Partial<ConfigDiagnostic> {
  if (offset === undefined) return {};
  const { line, column } = offsetToPosition(text, offset);
  return { line, column };
}

/**
 * Build a diagnostic with every free-text field sanitised.
 *
 * Central, because each field is built from repository content: `message` from
 * a value, `path` from a key, `remediation` sometimes from an error. An earlier
 * version redacted only the message, and a key named
 * `API_TOKEN=<value>` put its value straight into `path`.
 */
function diagnostic(
  code: ConfigDiagnosticCode,
  message: string,
  extra: Partial<ConfigDiagnostic> = {},
): ConfigDiagnostic {
  const { file, path, remediation, line, column } = extra;
  return {
    code,
    message: redact(message),
    file: redact(file ?? CONFIG_FILE_NAME),
    ...(line !== undefined ? { line } : {}),
    ...(column !== undefined ? { column } : {}),
    ...(path !== undefined ? { path: redact(path) } : {}),
    ...(remediation !== undefined ? { remediation: redact(remediation) } : {}),
  };
}

function invalid(diagnostics: readonly ConfigDiagnostic[]): ResolvedConfig {
  return { ...DEFAULT_CONFIG, source: CONFIG_FILE_NAME, valid: false, diagnostics };
}

function firstLine(message: string): string {
  return message.split('\n')[0]?.trim() ?? message;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
