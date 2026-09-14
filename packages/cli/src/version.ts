/**
 * Version reported by `setupguard --version`.
 *
 * Kept as a literal rather than read from package.json: the built `dist/` is
 * two directories away from the manifest, and a wrong relative path would only
 * fail at run time.
 */
export const CLI_VERSION = '0.1.0';
