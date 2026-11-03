import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Keep `audit.ignore` in pnpm-workspace.yaml honest.
 *
 * pnpm's ignore list is a bare list of GHSA ids: no reason, no expiry. An
 * exception added there would otherwise stay forever, silently. This check
 * runs in CI right before `pnpm audit` and fails when:
 *
 * - an ignored advisory has no entry below (an exception nobody justified);
 * - an entry below is no longer ignored (a stale record);
 * - today (UTC) is past an entry's review date.
 *
 * Passing the review date does not mean the risk changed. It means somebody
 * must look again: check whether a compatible fix now exists, and either
 * remove the exception or renew it with a new date and fresh evidence.
 *
 * `--today=YYYY-MM-DD` overrides the date, for testing the check. An argument,
 * not an environment variable: the override is not configuration.
 */
const EXCEPTIONS = {
  'GHSA-g3hv-75wg-m249': {
    reviewBy: '2026-11-30',
    packages: 'minimatch 3.1.5 and 10.2.6, through eslint, typescript-eslint and @vscode/vsce (development only)',
    record: 'Notes/17-github-action-implementada.md',
  },
};

const say = (line) => process.stdout.write(`${line}\n`);
const fail = (lines) => {
  for (const line of lines) process.stderr.write(`audit exception: ${line}\n`);
  process.exit(1);
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// `yaml` is a dependency of @setupguard/core; resolving it from there avoids
// adding a root dependency for a dozen lines of parsing.
const requireFromCore = createRequire(path.join(root, 'packages', 'core', 'package.json'));
const { parse } = requireFromCore('yaml');

const workspace = parse(readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8')) ?? {};
const ignored = workspace.audit?.ignore ?? [];
if (!Array.isArray(ignored)) fail(['pnpm-workspace.yaml: audit.ignore must be a list']);
if (workspace.auditConfig !== undefined) {
  fail(['pnpm-workspace.yaml: use audit.ignore, not the deprecated auditConfig']);
}

const todayArg = process.argv.slice(2).find((arg) => arg.startsWith('--today='));
const today = todayArg ? todayArg.slice('--today='.length) : new Date().toISOString().slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) fail([`--today is not a YYYY-MM-DD date: ${today}`]);

const problems = [];
for (const id of ignored) {
  const entry = EXCEPTIONS[id];
  if (!entry) {
    problems.push(`${id} is ignored in pnpm-workspace.yaml but has no review entry in scripts/check-audit-exceptions.mjs`);
  } else if (today > entry.reviewBy) {
    problems.push(
      `${id} (${entry.packages}) was due for review on ${entry.reviewBy}. ` +
        `Check for a compatible fix, then remove the exception or renew it with new evidence in ${entry.record}.`,
    );
  }
}
for (const id of Object.keys(EXCEPTIONS)) {
  if (!ignored.includes(id)) problems.push(`${id} has a review entry but is not ignored any more; remove the entry`);
}
if (problems.length > 0) fail(problems);

for (const id of ignored) {
  say(`audit exception ${id}: accepted until ${EXCEPTIONS[id].reviewBy} (${EXCEPTIONS[id].record})`);
}
