import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';

/**
 * Build the extension entry point that VS Code loads.
 *
 * The workspace packages are ESM and the extension host loads its entry point
 * with `require`, so the bundle is CommonJS and named `.cjs` — an explicit
 * extension beats relying on the nearest `package.json`, which says `module`.
 *
 * Bundling is not an optimisation here: a VSIX has no `node_modules`, so
 * `@setupguard/core`, `@setupguard/adapter-node` and `yaml` have to be inlined
 * or the extension cannot start.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const outfile = path.join(root, 'out', 'extension.cjs');

await rm(path.join(root, 'out'), { recursive: true, force: true });

const result = await esbuild.build({
  entryPoints: [path.join(root, 'src', 'extension.ts')],
  outfile,
  bundle: true,
  format: 'cjs',
  platform: 'node',
  // The floor the whole repository targets. Anything newer would silently
  // require a VS Code build that this manifest claims to support.
  target: 'node22.13',
  // Supplied by the extension host, never present on disk.
  external: ['vscode'],
  // The VSIX ships no sources, so a map would point at files nobody has.
  sourcemap: false,
  minify: false,
  legalComments: 'none',
  logLevel: 'info',
  metafile: true,
});

const bytes = Object.values(result.metafile.outputs).reduce((total, output) => total + output.bytes, 0);
process.stdout.write(`bundled ${outfile} (${(bytes / 1024).toFixed(1)} kB)\n`);
