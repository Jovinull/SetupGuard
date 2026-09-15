/**
 * Central sanitisation of every string that reaches a report.
 *
 * The rule "no finding contains a secret" cannot be enforced by asking each
 * check to remember it, and it cannot be enforced by listing the shapes seen so
 * far either. Review has found leaks through four separate channels:
 *
 * - a documented command such as `TOKEN=abc123 npm run build`, quoted from a README;
 * - the same command written as a flag, `npm run deploy --token=abc123`;
 * - a native `JSON.parse` message, which echoes a slice of the input it choked on;
 * - an arbitrary `Error.message` thrown from inside a check.
 *
 * So the engine sanitises every result on the way out, and the rules below are
 * written against the *class* of the problem rather than the examples:
 *
 * | Shape            | Rule                                                        |
 * |------------------|-------------------------------------------------------------|
 * | `NAME=value`     | always redacted — an environment value is never printable    |
 * | `--flag=value`   | redacted when the flag name is credential-shaped             |
 * | `Key: value`     | redacted when the key is credential-shaped                   |
 * | `user:pw@host`   | always redacted                                              |
 * | `Bearer <token>` | always redacted                                              |
 *
 * The flag and key rules are decided by the **name**, never by the delimiter.
 * An earlier version keyed off the delimiter instead: it refused to touch
 * anything preceded by `-`, so `--otp=123456` sailed through while `OTP=123456`
 * was redacted. Delimiters do not carry meaning; names do.
 */

/** Longest string allowed in any report field. Repository content is unbounded. */
export const MAX_FIELD_LENGTH = 400;

/** Longest path allowed in a report field. */
export const MAX_PATH_LENGTH = 200;

export const REDACTED = '***';

/**
 * Words that make a key credential-shaped.
 *
 * Matched against the key split into words, so `--api-key`, `apiKey`,
 * `API_KEY` and `X-Api-Key` all reduce to `api` + `key` and are caught, while
 * `--keyword` stays one word and is not. Adding a word here is the intended way
 * to extend coverage.
 */
const SENSITIVE_WORDS: ReadonlySet<string> = new Set([
  'auth',
  'authentication',
  'authorization',
  'bearer',
  'cookie',
  'credential',
  'credentials',
  'dsn',
  'jwt',
  'key',
  'keys',
  'otp',
  'passcode',
  'passphrase',
  'passwd',
  'password',
  'pin',
  'pwd',
  'salt',
  'secret',
  'secrets',
  'session',
  'signature',
  'token',
  'tokens',
]);

/**
 * True when a key name looks like it carries a credential.
 *
 * The key is split on camelCase humps and on any non-alphanumeric separator, so
 * one word list covers every naming convention.
 */
export function isSensitiveKey(key: string): boolean {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word !== '')
    .some((word) => SENSITIVE_WORDS.has(word.toLowerCase()));
}

/**
 * `NAME=value` as written in a shell command or a dotenv line.
 *
 * Every one of these is redacted regardless of the name: the right-hand side of
 * a bare assignment is an environment value, and this tool must never print
 * one. Guards:
 *
 * - the lookbehind stops `a.b=c` and `path/to=x` from being read as assignments;
 * - `(?!=)` stops `>=`, `==` and `!=` matching, keeping ranges like `>=20` intact;
 * - the value must be non-empty, so a template line like `DATABASE_URL=` —
 *   which carries no secret and whose emptiness is meaningful — is untouched.
 */
const ASSIGNMENT = /(?<![\w$.\-/])([A-Za-z_][A-Za-z0-9_]*)=(?!=)("[^"]*"|'[^']*'|[^\s;&|)'"]+)/g;

/**
 * `--flag=value` or `-f=value`.
 *
 * Unlike a bare assignment, a flag is usually an ordinary option, so redacting
 * every one of them would destroy the readability of a documented command
 * (`--filter=web`, `--port=3000`). The flag *name* decides instead.
 */
const FLAG_ASSIGNMENT =
  /(^|[\s;&|(])(--?[A-Za-z][A-Za-z0-9._-]*)=("[^"]*"|'[^']*'|[^\s;&|)'"]+)/g;

/**
 * `--flag value`, the same option written with a space.
 *
 * `npm publish --otp 123456` is as common as the `=` form, so covering only the
 * latter would leave the class half-closed. The value must not itself start
 * with `-`, which is how the next flag is told apart from a value.
 */
const FLAG_SPACED_VALUE =
  /(^|[\s;&|(])(--?[A-Za-z][A-Za-z0-9._-]*)(\s+)("[^"]*"|'[^']*'|[^\s;&|)'"-][^\s;&|)'"]*)/g;

/**
 * `Key: value` or `Key:value`, the shape of an HTTP header or a prose label.
 *
 * Only credential-shaped keys are redacted: this tool's own messages are full
 * of harmless labels (`Multiple lockfiles present: ...`), and redacting those
 * would gut the report. When it does fire it takes the rest of the line, since
 * a header value has no reliable terminator.
 *
 * The leading character class includes `=` and quotes so that a header nested
 * inside another option is still caught: `curl --header=Authorization:abc` and
 * `curl -H "Authorization: abc"` both hide a credential behind a flag whose own
 * name is innocuous.
 */
const KEYED_VALUE = /(^|[\s(,;="'`])([A-Za-z][A-Za-z0-9._-]*)(\s*:\s*)([^\r\n]+)/g;

/** Credentials embedded in a URL, e.g. `postgres://user:pw@host/db`. */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi;

/** A bearer token with no key in front of it. */
const BARE_BEARER = /\bbearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi;

/**
 * C0/C1 control characters, except tab and newline. Repository content can
 * contain them, and pasting them into a terminal corrupts the output.
 */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARS = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]', 'g');

/**
 * Remove credential-shaped substrings and cap the length.
 *
 * Deliberately conservative about what it keeps, not about what it removes:
 * over-redacting a message costs clarity, under-redacting costs a leaked
 * secret.
 */
export function redact(value: string, maxLength = MAX_FIELD_LENGTH): string {
  const cleaned = value
    .replace(URL_CREDENTIALS, (_m, scheme: string, user: string) => `${scheme}${user}:${REDACTED}@`)
    .replace(FLAG_ASSIGNMENT, (match, lead: string, flag: string) =>
      isSensitiveKey(flag) ? `${lead}${flag}=${REDACTED}` : match,
    )
    .replace(FLAG_SPACED_VALUE, (match, lead: string, flag: string, gap: string) =>
      isSensitiveKey(flag) ? `${lead}${flag}${gap}${REDACTED}` : match,
    )
    .replace(ASSIGNMENT, (_m, name: string) => `${name}=${REDACTED}`)
    .replace(KEYED_VALUE, (match, lead: string, key: string, separator: string) =>
      isSensitiveKey(key) ? `${lead}${key}${separator}${REDACTED}` : match,
    )
    .replace(BARE_BEARER, REDACTED)
    .replace(CONTROL_CHARS, ' ');

  return cleaned.length <= maxLength ? cleaned : `${cleaned.slice(0, maxLength - 1)}…`;
}

/** Apply {@link redact} to a value that may be absent. */
export function redactOptional(value: string | undefined, maxLength?: number): string | undefined {
  return value === undefined ? undefined : redact(value, maxLength);
}

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
 * V8 phrases the error as `Unexpected token 's', "QA-FAKE-CREDENTIAL"... is not valid
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
