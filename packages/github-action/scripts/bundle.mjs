import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';

import { writeThirdPartyNotices } from '../../../scripts/third-party-notices.mjs';

/**
 * Build `dist/index.cjs`, the file `action.yml` runs.
 *
 * A JavaScript action is downloaded as-is and started with `node`: there is no
 * install step, so the engine, the Node adapter and `yaml`/`semver` are all
 * inlined. The file is committed, and CI rebuilds it and fails if the result
 * differs from what is in the repository — that is what ties the code that
 * runs to the code that was reviewed.
 *
 * Reproducibility: same lockfile + same sources = same bytes. The working
 * directory is pinned to the repository root so the path comments esbuild
 * writes do not depend on where the script is started from, and nothing
 * time- or machine-dependent is emitted.
 *
 * CommonJS with a `.cjs` name because the repository's package.json says
 * `"type": "module"`, and the runner starts `main` with plain `node`.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, '..');
const repoRoot = path.resolve(packageRoot, '..', '..');
const outdir = path.join(packageRoot, 'dist');
const outfile = path.join(outdir, 'index.cjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

const result = await esbuild.build({
  absWorkingDir: repoRoot,
  entryPoints: [path.join(packageRoot, 'src', 'main.ts')],
  // Bundle the workspace packages from their TypeScript sources, not from
  // their `dist/` (which is what their package.json `exports` point at). The
  // `dist/` only exists after `tsc -b`, and a stale one would silently produce
  // a stale bundle; sources are always what was reviewed.
  alias: {
    '@setupguard/core': path.join(repoRoot, 'packages', 'core', 'src', 'index.ts'),
    '@setupguard/adapter-node': path.join(repoRoot, 'packages', 'adapter-node', 'src', 'index.ts'),
  },
  outfile,
  bundle: true,
  format: 'cjs',
  platform: 'node',
  // action.yml runs it on node24; the floor keeps the bundle loadable by the
  // test suite on every Node version the repository supports.
  target: 'node22.13',
  sourcemap: false,
  minify: false,
  legalComments: 'none',
  charset: 'utf8',
  logLevel: 'warning',
  metafile: true,
});

const bytes = Object.values(result.metafile.outputs).reduce((total, output) => total + output.bytes, 0);
process.stdout.write(`bundled ${path.relative(repoRoot, outfile)} (${(bytes / 1024).toFixed(1)} kB)\n`);

const notices = writeThirdPartyNotices({
  metafile: result.metafile,
  workingDir: repoRoot,
  outfile: path.join(outdir, 'THIRD_PARTY_NOTICES.txt'),
  product: 'The SetupGuard GitHub Action (dist/index.cjs)',
});
process.stdout.write(`third-party notices: ${notices.join(', ')}\n`);
