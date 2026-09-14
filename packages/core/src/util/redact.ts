/**
 * Central sanitisation of every string that reaches a report.
 *
 * The rule "no finding contains a secret" cannot be enforced by asking each
 * check to remember it. Three separate channels were found leaking values in
 * review:
 *
 * - a documented command such as `TOKEN=abc123 npm run build`, quoted verbatim
 *   from a README;
 * - a native `JSON.parse` message, which echoes a slice of the input it choked
 *   on — and that slice is the beginning of the file;
 * - an arbitrary `Error.message` thrown from inside a check.
 *
 * So the engine sanitises every finding and every reason on the way out,
 * after the check has run and before anything is serialised or rendered. A
 * check that forgets is still safe.
 */

/** Longest string allowed in any report field. Repository content is unbounded. */
export const MAX_FIELD_LENGTH = 400;

/**
 * `NAME=value` assignments, as written in a shell command or a dotenv line.
 *
 * The name is kept (it is the useful part and never secret); the value is
 * replaced. Guards:
 *
 * - the lookbehind stops `--filter=web` and `a.b=c` from being treated as an
 *   assignment whose name is `filter` / `b`;
 * - `(?!=)` stops `>=`, `==` and `!=` from matching, which keeps semver ranges
 *   such as `>=20` and comparisons in messages intact;
 * - the value must be non-empty, so a template line like `DATABASE_URL=` —
 *   which carries no secret and whose emptiness is meaningful — is untouched.
 */
const ASSIGNMENT = /(?<![\w$.\-/])([A-Za-z_][A-Za-z0-9_]*)=(?!=)("[^"]*"|'[^']*'|[^\s;&|)'"]+)/g;

/**
 * C0/C1 control characters, except tab and newline. Repository content can
 * contain them, and pasting them into a terminal corrupts the output.
 */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARS = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]', 'g');

/** Credentials embedded in a URL, e.g. `postgres://user:pw@host/db`. */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi;

/** Long opaque tokens that look like credentials regardless of context. */
const BEARER = /\b(?:bearer|token|api[_-]?key)\s+[A-Za-z0-9._~+/-]{12,}=*/gi;

export const REDACTED = '***';

/**
 * Remove credential-shaped substrings and cap the length.
 *
 * Deliberately conservative about what it keeps, not about what it removes:
 * over-redacting a message costs clarity, under-redacting costs a leaked
 * secret.
 */
export function redact(value: string, maxLength = MAX_FIELD_LENGTH): string {
  const cleaned = value
    .replace(URL_CREDENTIALS, (_match, scheme: string, user: string) => `${scheme}${user}:${REDACTED}@`)
    .replace(ASSIGNMENT, (_match, name: string) => `${name}=${REDACTED}`)
    .replace(BEARER, REDACTED)
    // Control characters in repository content could corrupt terminal output.
    .replace(CONTROL_CHARS, ' ');

  return cleaned.length <= maxLength ? cleaned : `${cleaned.slice(0, maxLength - 1)}…`;
}

/** Apply {@link redact} to a value that may be absent. */
export function redactOptional(value: string | undefined, maxLength?: number): string | undefined {
  return value === undefined ? undefined : redact(value, maxLength);
}

/** Longest path allowed in a report field. */
export const MAX_PATH_LENGTH = 200;

/**
 * Sanitise a filesystem path, segment by segment.
 *
 * A path is not free text and cannot go through {@link redact} directly: the
 * assignment lookbehind excludes `/`, so `deep/dir/TOKEN=secret.js` would be
 * left untouched while the top-level `TOKEN=secret.js` was redacted. Splitting
 * on the separators first means every segment is judged on its own, and the
 * separators survive so the path still reads as a path.
 *
 * A filename *is* repository content: a file called `TOKEN=value.js` puts its
 * own name into the report, the terminal, and the editor's Problems panel.
 * Navigation to such a file is lost, which is the correct trade.
 */
export function redactPath(value: string): string {
  const cleaned = value.replace(/[^/\\]+/g, (segment) => redact(segment, MAX_PATH_LENGTH));
  return cleaned.length <= MAX_PATH_LENGTH
    ? cleaned
    : `${cleaned.slice(0, MAX_PATH_LENGTH - 1)}…`;
}

/** Apply {@link redactPath} to a value that may be absent. */
export function redactPathOptional(value: string | undefined): string | undefined {
  return value === undefined ? undefined : redactPath(value);
}

/**
 * Describe a thrown value without repeating text it may have copied out of a
 * file. Only the error name and its (redacted, capped) message survive.
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) return redact(`${error.name}: ${error.message}`);
  return redact(String(error));
}

/**
 * Describe a `JSON.parse` failure **without** its native message.
 *
 * V8 phrases the error as `Unexpected token 's', "sk_live_ab"... is not valid
 * JSON` — the quoted fragment is the start of the file being parsed. For a
 * malformed config that begins with a credential, the message *is* the secret.
 * Only the position is extracted; the rest is discarded.
 */
export function describeJsonParseError(error: unknown): {
  message: string;
  line?: number;
  column?: number;
} {
  const raw = error instanceof Error ? error.message : String(error);

  const lineColumn = /line (\d+) column (\d+)/.exec(raw);
  if (lineColumn?.[1] && lineColumn[2]) {
    const line = Number(lineColumn[1]);
    const column = Number(lineColumn[2]);
    return { message: `invalid JSON at line ${line}, column ${column}`, line, column };
  }

  const position = /position (\d+)/.exec(raw);
  if (position?.[1]) {
    return { message: `invalid JSON at character offset ${position[1]}` };
  }

  return { message: 'invalid JSON' };
}
