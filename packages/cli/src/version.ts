import { createRequire } from 'node:module';

/**
 * Version reported by `setupguard --version`, read from the package manifest.
 *
 * Both `src/` and `dist/` sit one level under the package root, so the same
 * relative path works whether this module runs from source (tests) or from the
 * build (the published bin). Hard-coding the string here instead meant two
 * places to bump and one of them would eventually be wrong.
 */
const manifest = createRequire(import.meta.url)('../package.json') as { version: string };

export const CLI_VERSION: string = manifest.version;
