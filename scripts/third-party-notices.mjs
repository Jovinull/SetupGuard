import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Write THIRD_PARTY_NOTICES.txt for a bundle.
 *
 * A bundle inlines third-party code, and the licenses of that code travel with
 * it: `yaml` and `semver` are ISC, which allows redistribution "provided that
 * the above copyright notice and this permission notice appear in all
 * copies". esbuild drops license comments (`legalComments: 'none'`), and these
 * packages keep their notice in a LICENSE file anyway, so the notice has to be
 * shipped next to the bundle instead.
 *
 * The package list comes from esbuild's metafile — what was actually inlined,
 * not what the lockfile contains. A bundled package without a license file
 * stops the build: shipping it without one is the problem this exists to stop.
 *
 * Output is sorted and LF-only, so a rebuild produces the same bytes.
 */
export function writeThirdPartyNotices({ metafile, workingDir, outfile, product }) {
  const packages = new Map();
  for (const input of Object.keys(metafile.inputs)) {
    const normalized = input.replace(/\\/g, '/');
    const index = normalized.lastIndexOf('node_modules/');
    if (index < 0) continue;
    const rest = normalized.slice(index + 'node_modules/'.length).split('/');
    const nameParts = rest[0]?.startsWith('@') ? rest.slice(0, 2) : rest.slice(0, 1);
    const dir = path.resolve(workingDir, normalized.slice(0, index), 'node_modules', ...nameParts);
    const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    packages.set(`${manifest.name}@${manifest.version}`, { manifest, dir });
  }

  const sections = [...packages.keys()].sort().map((key) => {
    const { manifest, dir } = packages.get(key);
    const licenseFile = readdirSync(dir)
      .sort()
      .find((name) => /^(licen[cs]e|copying)(\.|$)/i.test(name));
    if (!licenseFile) {
      throw new Error(`${key} is bundled but ships no license file; refusing to build without its notice`);
    }
    const text = readFileSync(path.join(dir, licenseFile), 'utf8').replace(/\r\n?/g, '\n').trim();
    return `${key} (${manifest.license ?? 'license not declared'})\n${'-'.repeat(key.length)}\n\n${text}\n`;
  });

  const header =
    `${product} bundles the following third-party packages. Their licenses ` +
    'require these notices to accompany every copy.\n';
  writeFileSync(outfile, [header, ...sections].join('\n'), 'utf8');
  return [...packages.keys()].sort();
}
