/** Subset of `package.json` that SetupGuard reads. */
export interface PackageJson {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly private?: unknown;
  readonly scripts?: unknown;
  readonly engines?: unknown;
  readonly packageManager?: unknown;
  readonly volta?: unknown;
  readonly workspaces?: unknown;
  readonly dependencies?: unknown;
  readonly devDependencies?: unknown;
}

/** Result of loading `package.json`, including the failure modes. */
export type PackageJsonState =
  | { readonly kind: 'missing' }
  | { readonly kind: 'unreadable'; readonly error: string }
  | {
      readonly kind: 'invalid';
      /** Our own description. The native parser message is never kept: it quotes the input. */
      readonly error: string;
      readonly line?: number;
      readonly column?: number;
      readonly raw: string;
    }
  | { readonly kind: 'not-an-object'; readonly raw: string }
  | { readonly kind: 'ok'; readonly data: PackageJson; readonly raw: string };

/** `scripts` as a string map, ignoring non-string entries. */
export function readScripts(data: PackageJson): Record<string, string> {
  const scripts = data.scripts;
  if (!isPlainObject(scripts)) return {};
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(scripts)) {
    if (typeof value === 'string') result[name] = value;
  }
  return result;
}

/** `engines.node`, when declared as a string. */
export function readEnginesNode(data: PackageJson): string | undefined {
  const engines = data.engines;
  if (!isPlainObject(engines)) return undefined;
  const node = engines['node'];
  return typeof node === 'string' ? node : undefined;
}

/** `volta.node`, when declared as a string. */
export function readVoltaNode(data: PackageJson): string | undefined {
  const volta = data.volta;
  if (!isPlainObject(volta)) return undefined;
  const node = volta['node'];
  return typeof node === 'string' ? node : undefined;
}

/** `packageManager`, e.g. `pnpm@9.12.0`, split into name and version. */
export function readPackageManagerField(
  data: PackageJson,
): { readonly name: string; readonly version?: string } | undefined {
  const raw = data.packageManager;
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  // Corepack allows a `+sha` suffix; ignore it.
  const [spec] = raw.trim().split('+');
  const match = /^([a-z][\w-]*)(?:@(.+))?$/i.exec(spec ?? '');
  if (!match?.[1]) return undefined;
  return match[2] === undefined ? { name: match[1] } : { name: match[1], version: match[2] };
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
