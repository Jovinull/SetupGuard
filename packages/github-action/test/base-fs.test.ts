import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { nodeAdapter } from '@setupguard/adapter-node';
import {
  AdapterRegistry,
  loadConfig,
  NodeEnvironmentProbe,
  NodeWorkspaceFs,
  runDiagnosis,
  type Report,
  type WalkOptions,
  type WorkspaceFs,
} from '@setupguard/core';
import { fixture } from '@setupguard/testing';
import { describe, expect, it } from 'vitest';

import { BaseWorkspaceFs, MAX_FILE_BYTES, walkOrder, type BaseEntry } from '../src/index.js';
import { caseDirs, fakeGitHub } from './support.js';

/**
 * The base view must answer every question exactly as a real checkout of the
 * base would. These tests build that real checkout (the fixture's `base/`) and
 * compare, method by method and then report against report.
 */

const CASES = (await fs.readdir(fixture('pull-requests'))).sort();

async function baseView(caseName: string): Promise<{ view: BaseWorkspaceFs; real: WorkspaceFs; loads: string[] }> {
  const dirs = caseDirs(caseName);
  const github = await fakeGitHub(dirs.base, dirs.head);
  const changed = github.files.flatMap((f) => [f.filename, ...(f.previous_filename ? [f.previous_filename] : [])]);
  const loads: string[] = [];
  const view = new BaseWorkspaceFs({
    head: new NodeWorkspaceFs(dirs.head, { maxFileBytes: MAX_FILE_BYTES }),
    changed,
    maxFileBytes: MAX_FILE_BYTES,
    load: async (relative): Promise<BaseEntry> => {
      loads.push(relative);
      try {
        const stats = await fs.stat(path.join(dirs.base, relative));
        if (stats.isDirectory()) return { kind: 'dir' };
        return { kind: 'file', text: await fs.readFile(path.join(dirs.base, relative), 'utf8') };
      } catch {
        return { kind: 'absent' };
      }
    },
  });
  return { view, real: new NodeWorkspaceFs(dirs.base, { maxFileBytes: MAX_FILE_BYTES }), loads };
}

async function diagnose(workspace: WorkspaceFs): Promise<Report> {
  const registry = new AdapterRegistry([nodeAdapter]);
  const config = await loadConfig({
    fs: workspace,
    knownCheckIds: registry.list().flatMap((a) => a.checks.map((c) => c.id)),
  });
  return runDiagnosis({
    fs: workspace,
    environment: new NodeEnvironmentProbe({ env: {} }),
    registry,
    levels: ['static'],
    config,
    now: () => new Date(0),
  });
}

/** The parts of a report that describe the project, not the run. */
function substance(report: Report) {
  return {
    readiness: report.readiness,
    summary: report.summary,
    results: report.results.map(({ durationMs: _d, ...rest }) => rest),
  };
}

const WALKS: WalkOptions[] = [
  {},
  { extensions: ['.js', '.ts'] },
  { names: ['package.json'] },
  { dir: 'src' },
  { dir: 'docs', extensions: ['.md'], maxDepth: 3, maxFiles: 50 },
  { maxFiles: 2 },
  { maxDepth: 0 },
  { ignore: ['src/**'] },
];

describe.each(CASES)('base view of fixtures/pull-requests/%s', (caseName) => {
  it('produces the same report as a real checkout of the base', async () => {
    const { view, real } = await baseView(caseName);
    expect(substance(await diagnose(view))).toEqual(substance(await diagnose(real)));
    expect(view.problems).toEqual([]);
  });

  it.each(WALKS.map((o) => [JSON.stringify(o), o] as const))('walks like the base with %s', async (_label, options) => {
    const { view, real } = await baseView(caseName);
    expect(await view.walk(options)).toEqual(await real.walk(options));
  });

  it('answers isFile, readText and listDir like the base', async () => {
    const { view, real } = await baseView(caseName);
    const dirs = caseDirs(caseName);
    const paths = new Set<string>(['.', 'src', 'missing', 'src/missing.js']);
    for (const side of [dirs.base, dirs.head]) {
      for (const file of (await new NodeWorkspaceFs(side).walk({})).files) {
        paths.add(file);
        paths.add(path.posix.dirname(file));
      }
    }
    for (const p of [...paths].sort()) {
      expect(await view.isFile(p), `isFile(${p})`).toBe(await real.isFile(p));
      expect(await view.exists(p), `exists(${p})`).toBe(await real.exists(p));
      if (await real.isFile(p)) expect(await view.readText(p), `readText(${p})`).toBe(await real.readText(p));
      else await expect(view.readText(p)).rejects.toThrow();
      expect((await view.listDir(p)).sort(), `listDir(${p})`).toEqual((await real.listDir(p)).sort());
    }
  });
});

describe('BaseWorkspaceFs edge cases', () => {
  async function scratch(): Promise<string> {
    return fs.mkdtemp(path.join(os.tmpdir(), 'setupguard-basefs-'));
  }

  it('refuses to guess when a changed path is a symlink on the base, and records why', async () => {
    const head = await scratch();
    await fs.writeFile(path.join(head, 'package.json'), '{}');
    const view = new BaseWorkspaceFs({
      head: new NodeWorkspaceFs(head),
      changed: ['package.json'],
      maxFileBytes: MAX_FILE_BYTES,
      load: () => Promise.resolve({ kind: 'symlink' }),
    });
    await expect(view.isFile('package.json')).rejects.toThrow(/symlink/);
    expect(view.problems).toHaveLength(1);
    // The disk walker never lists symlinks, so a walk can be answered exactly.
    expect((await view.walk({})).files).toEqual([]);
  });

  it('reports a file above the size limit the way the disk reader does', async () => {
    const head = await scratch();
    const view = new BaseWorkspaceFs({
      head: new NodeWorkspaceFs(head),
      changed: ['big.md'],
      maxFileBytes: MAX_FILE_BYTES,
      load: () => Promise.resolve({ kind: 'too-large', size: MAX_FILE_BYTES + 1 }),
    });
    expect(await view.isFile('big.md')).toBe(true);
    await expect(view.readText('big.md')).rejects.toThrow(/above the .* byte limit/);
  });

  it('never resolves a path outside the workspace through the base', async () => {
    const head = await scratch();
    let loads = 0;
    const view = new BaseWorkspaceFs({
      head: new NodeWorkspaceFs(head),
      changed: ['a.js'],
      maxFileBytes: MAX_FILE_BYTES,
      load: () => {
        loads += 1;
        return Promise.resolve({ kind: 'file', text: 'x' });
      },
    });
    await expect(view.readText('../a.js')).rejects.toThrow();
    await expect(view.readText('/etc/passwd')).rejects.toThrow();
    expect(await view.isFile('src/../../a.js')).toBe(false);
    expect(loads).toBe(0);
  });

  it('fetches each changed path at most once', async () => {
    const head = await scratch();
    let loads = 0;
    const view = new BaseWorkspaceFs({
      head: new NodeWorkspaceFs(head),
      changed: ['README.md'],
      maxFileBytes: MAX_FILE_BYTES,
      load: () => {
        loads += 1;
        return Promise.resolve({ kind: 'file', text: '# hi' });
      },
    });
    await Promise.all([view.readText('README.md'), view.isFile('README.md'), view.walk({}), view.listDir('.')]);
    expect(loads).toBe(1);
  });
});

describe('walkOrder', () => {
  it('matches the depth-first order of the disk walker, not plain string order', () => {
    const files = ['a/c', 'a-b', 'b', 'a/b/z', 'A'];
    expect([...files].sort(walkOrder)).toEqual(['A', 'a/b/z', 'a/c', 'a-b', 'b']);
    expect([...files].sort()).not.toEqual([...files].sort(walkOrder));
  });
});
