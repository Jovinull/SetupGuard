/**
 * Key-only `.env` parser.
 *
 * SetupGuard must be able to say *which* variables a file declares without ever
 * holding their values, so this parser deliberately discards the right-hand
 * side (`Notes/09-seguranca-e-confiabilidade.md`).
 */

export interface DotenvEntry {
  readonly key: string;
  /** 1-based line of the declaration. */
  readonly line: number;
  /** True when the declaration has an empty right-hand side, e.g. `API_URL=`. */
  readonly empty: boolean;
}

export interface DotenvFile {
  readonly path: string;
  readonly entries: readonly DotenvEntry[];
  readonly keys: ReadonlySet<string>;
}

const DECLARATION = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=(.*)$/;

export function parseDotenvKeys(path: string, text: string): DotenvFile {
  const entries: DotenvEntry[] = [];
  const keys = new Set<string>();
  const lines = text.split(/\r?\n/);

  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const match = DECLARATION.exec(line);
    const key = match?.[1];
    if (!key) continue;
    // The value is only inspected for emptiness and immediately dropped.
    const empty = stripInlineComment(match[2] ?? '').trim() === '';
    entries.push({ key, line: index + 1, empty });
    keys.add(key);
  }

  return { path, entries, keys };
}

function stripInlineComment(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) return trimmed;
  const hash = trimmed.indexOf(' #');
  return hash === -1 ? trimmed : trimmed.slice(0, hash);
}

/** Candidate names for the committed template file, in precedence order. */
export const ENV_EXAMPLE_FILES: readonly string[] = [
  '.env.example',
  '.env.sample',
  '.env.template',
  '.env.dist',
  'env.example',
];

/**
 * Local environment files, in load order.
 *
 * **This layering is a heuristic, not a Node.js contract.** Next.js, Vite and
 * similar frameworks cascade these files; plain `dotenv` loads only `.env`
 * unless the application asks for more. SetupGuard merges them because the
 * opposite default — reading only `.env` — reported variables as missing that
 * every framework-based project genuinely provides, and a false blocker costs
 * more trust than a missed one.
 *
 * The cost of the choice is the mirror case: a variable present only in
 * `.env.development` is treated as provided even if the process loads `.env`
 * alone. Which files apply belongs in per-project configuration or in
 * framework detection; both are still open
 * (`Notes/10-adapters-e-configuracao.md`).
 */
export const ENV_LOCAL_FILES: readonly string[] = ['.env', '.env.development', '.env.local'];

/** Whether a variable is provided by the merged local environment files. */
export type LocalKeyState = 'absent' | 'empty' | 'set';

/**
 * Merge layered dotenv files.
 *
 * A later file overrides an earlier one, including overriding a value with an
 * empty one. `empty` is kept distinct from `set` because `DATABASE_URL=` in a
 * `.env` is an unfilled placeholder, not a provided value — treating it as
 * present was a false `READY`.
 */
export function mergeLocalKeys(files: readonly DotenvFile[]): Map<string, LocalKeyState> {
  const merged = new Map<string, LocalKeyState>();
  for (const file of files) {
    for (const entry of file.entries) {
      merged.set(entry.key, entry.empty ? 'empty' : 'set');
    }
  }
  return merged;
}

/**
 * Variables provided by the platform or the toolchain. They are never reported
 * as "undocumented" because no repository is expected to declare them.
 */
export const AMBIENT_ENV_VARS: ReadonlySet<string> = new Set([
  'CI',
  'HOME',
  'HOSTNAME',
  'LANG',
  'NODE_ENV',
  'NODE_OPTIONS',
  'PATH',
  'PWD',
  'SHELL',
  'TERM',
  'TMPDIR',
  'TZ',
  'USER',
  'USERPROFILE',
  'VERCEL',
  'VERCEL_ENV',
]);
