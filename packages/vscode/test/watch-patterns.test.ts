import { describe, expect, it } from 'vitest';

import { CONFIG_FILE_NAME, DEFAULT_IGNORED_DIRS, MISNAMED_CONFIG_FILES } from '@setupguard/core';
import { SOURCE_GLOBS, STRUCTURAL_FILES, WATCH_GLOBS, shouldTriggerRun } from 'setupguard';

/**
 * Two failure modes, opposite to each other: watching too little means the
 * status bar quietly goes stale, and watching too much means a `pnpm install`
 * turns into thousands of wake-ups.
 */

describe('WATCH_GLOBS', () => {
  it('covers every file a verdict can depend on', () => {
    const structural = WATCH_GLOBS.find((glob) => glob.startsWith('**/{'));
    expect(structural).toBeDefined();

    for (const name of [
      'package.json',
      'package-lock.json',
      'pnpm-lock.yaml',
      'yarn.lock',
      'bun.lock',
      '.nvmrc',
      '.node-version',
      '.env',
      '.env.example',
      CONFIG_FILE_NAME,
    ]) {
      expect(STRUCTURAL_FILES, name).toContain(name);
    }
  });

  it('watches the misspellings the loader warns about', () => {
    // Renaming `.setupguard.yaml` to `.setupguard.yml` has to clear the warning
    // without the user asking for a re-run.
    for (const name of MISNAMED_CONFIG_FILES) expect(STRUCTURAL_FILES).toContain(name);
  });

  it('watches nested manifests, because they move a workspace boundary', () => {
    expect(WATCH_GLOBS.some((glob) => glob.startsWith('**/{'))).toBe(true);
  });

  it('watches documentation and source, the two inferred inputs', () => {
    expect(WATCH_GLOBS).toContain('docs/**/*.md');
    expect(WATCH_GLOBS).toContain('*.md');
    for (const glob of SOURCE_GLOBS) expect(WATCH_GLOBS).toContain(glob);
    expect(SOURCE_GLOBS.some((glob) => glob.includes('ts'))).toBe(true);
  });

  it('holds no absolute path and no escape', () => {
    for (const glob of WATCH_GLOBS) {
      expect(glob.startsWith('/'), glob).toBe(false);
      expect(glob.includes('..'), glob).toBe(false);
    }
  });
});

describe('shouldTriggerRun', () => {
  it('accepts a file the engine would read', () => {
    expect(shouldTriggerRun('package.json')).toBe(true);
    expect(shouldTriggerRun('src/app.ts')).toBe(true);
    expect(shouldTriggerRun('docs/setup.md')).toBe(true);
    expect(shouldTriggerRun('apps/api/package.json')).toBe(true);
  });

  it('drops events from directories the engine never reads', () => {
    for (const dir of DEFAULT_IGNORED_DIRS) {
      expect(shouldTriggerRun(`${dir}/anything.js`), dir).toBe(false);
      expect(shouldTriggerRun(`nested/${dir}/anything.js`), dir).toBe(false);
    }
  });

  it('drops a deep node_modules path, which is what an install produces', () => {
    expect(shouldTriggerRun('node_modules/.pnpm/vite@5/node_modules/vite/package.json')).toBe(false);
  });

  it('folds Windows separators before deciding', () => {
    expect(shouldTriggerRun('node_modules\\left-pad\\package.json')).toBe(false);
    expect(shouldTriggerRun('src\\app.ts')).toBe(true);
  });

  it('does not mistake a file for a directory of the same name', () => {
    // `build` the directory is ignored; `build` the file is a file.
    expect(shouldTriggerRun('build')).toBe(true);
    expect(shouldTriggerRun('out')).toBe(true);
    expect(shouldTriggerRun('build/main.js')).toBe(false);
  });

  it('ignores an empty path', () => {
    expect(shouldTriggerRun('')).toBe(false);
  });
});
