import type { SeverityOverride } from './types.js';

/**
 * The single source of truth for the shape of `.setupguard.yml`.
 *
 * The validator in `validate.ts` and the JSON Schema published at
 * `schemas/setupguard.schema.json` are both built from the constants below, so
 * the two cannot describe different things. A test asserts the file on disk is
 * byte-identical to {@link configJsonSchema}, which means editing one without
 * the other fails CI (`Notes/15-configuracao.md`).
 */

export const CONFIG_FILE_NAME = '.setupguard.yml';

/**
 * Filenames that are almost certainly meant to be the configuration file.
 * Finding one of these instead is reported rather than ignored: a config that
 * is silently not loaded is the worst possible outcome for a tool whose job is
 * to catch silent drift.
 */
export const MISNAMED_CONFIG_FILES: readonly string[] = [
  '.setupguard.yaml',
  'setupguard.yml',
  'setupguard.yaml',
  '.setupguardrc',
  '.setupguardrc.yml',
];

/** The only `version` this release accepts. */
export const CONFIG_VERSION = 1;

export const SEVERITY_OVERRIDES: readonly SeverityOverride[] = ['error', 'warning', 'off'];

export const CONFIG_TOP_LEVEL_KEYS: readonly string[] = ['version', 'checks', 'env', 'ignore'];

export const CONFIG_ENV_KEYS: readonly string[] = ['optional'];

export const CONFIG_CHECK_KEYS: readonly string[] = ['severity'];

/**
 * A POSIX environment variable name. Deliberately strict: an entry that does
 * not look like a variable name is far more likely to be a mistake than an
 * exotic name, and accepting it would silently fail to suppress anything.
 */
export const ENV_VAR_NAME_PATTERN = '^[A-Za-z_][A-Za-z0-9_]*$';

/**
 * The grammar of an ignore pattern, as a list of named regular-expression
 * assertions.
 *
 * Written out rule by rule rather than as one opaque expression, because this
 * is the half of the contract an editor enforces and a reader has to be able to
 * check it against `normalizeIgnorePattern`, which enforces the other half.
 * The two must accept the same set of strings.
 */
const IGNORE_PATTERN_RULES: readonly string[] = [
  // No negation.
  '(?![!])',
  // No control characters: a pattern is one path, never several lines.
  '(?![\\s\\S]*[\\u0000-\\u001F\\u007F])',
  // No absolute path, POSIX or Windows.
  '(?![/])',
  '(?![A-Za-z]:[/])',
  // Backslash is not a separator here; the canonical spelling uses `/`.
  '(?![^]*\\\\)',
  // Constructs this dialect does not implement: braces, classes, extglob.
  '(?![^]*[\\[\\]{}()!+@])',
  // No `..` segment anywhere.
  '(?![^]*(?:^|/)\\.\\.(?:/|$))',
  // Canonical: no `./` prefix, no `.` segment, no empty segment, no trailing `/`.
  '(?![^]*(?:^|/)\\.(?:/|$))',
  '(?![^]*//)',
  '(?![^]*/$)',
  // At least one character that is not a separator or a dot.
  '(?=[^]*[^./\\s])',
];

/**
 * An ignore pattern. Equivalent to {@link normalizeIgnorePattern}'s acceptance
 * set, which a parity test verifies over a corpus.
 */
export const IGNORE_PATTERN_PATTERN = `^${IGNORE_PATTERN_RULES.join('')}\\S(?:[^]*\\S)?$`;

/** JSON Schema for `.setupguard.yml`, generated from the constants above. */
export function configJsonSchema(): Record<string, unknown> {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://setupguard.dev/schemas/setupguard.schema.json',
    title: 'SetupGuard configuration',
    description:
      'Optional configuration for a repository diagnosed by SetupGuard. Its purpose is to let a project declare legitimate exceptions, not to define policy.',
    type: 'object',
    required: ['version'],
    additionalProperties: false,
    properties: {
      version: {
        description: 'Configuration format version. Only 1 is supported.',
        const: CONFIG_VERSION,
      },
      checks: {
        description:
          'Severity overrides, keyed by check id. Which ids exist depends on the adapters loaded, so the schema accepts any key and the loader rejects unknown ones.',
        type: 'object',
        additionalProperties: {
          type: 'object',
          additionalProperties: false,
          properties: {
            severity: {
              description:
                'error and warning re-level every finding the check produces; off stops the check from running.',
              enum: [...SEVERITY_OVERRIDES],
            },
          },
        },
      },
      env: {
        description: 'Environment-variable contract exceptions.',
        type: 'object',
        additionalProperties: false,
        properties: {
          optional: {
            description:
              'Variables the project works without. Names only; SetupGuard never reads a value.',
            type: 'array',
            uniqueItems: true,
            items: { type: 'string', pattern: ENV_VAR_NAME_PATTERN },
          },
        },
      },
      ignore: {
        description:
          'Workspace-relative glob patterns excluded from the source and documentation scans. Structural files such as the root package.json are never hidden.',
        type: 'array',
        uniqueItems: true,
        items: { type: 'string', minLength: 1, pattern: IGNORE_PATTERN_PATTERN },
      },
    },
  };
}
