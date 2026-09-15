import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { SHOW_REPORT_COMMAND } from 'setupguard';

/**
 * The manifest is the part of the extension no unit test can exercise: VS Code
 * reads it, not us. What can be checked is that it agrees with the code, and
 * that what ships is only what should ship.
 */

const packageRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

interface Manifest {
  name: string;
  displayName: string;
  publisher: string;
  private: boolean;
  main: string;
  engines: Record<string, string>;
  extensionKind: string[];
  activationEvents: string[];
  categories: string[];
  contributes: { commands: { command: string; title: string; category: string }[] };
  capabilities: {
    untrustedWorkspaces: { supported: boolean; description?: string };
    virtualWorkspaces: { supported: boolean; description?: string };
  };
  scripts: Record<string, string>;
  dependencies?: Record<string, string>;
}

async function manifest(): Promise<Manifest> {
  return JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8')) as Manifest;
}

async function extensionSource(): Promise<string> {
  return fs.readFile(path.join(packageRoot, 'src', 'extension.ts'), 'utf8');
}

describe('extension manifest', () => {
  it('declares an identity VS Code can install', async () => {
    const pkg = await manifest();
    expect(pkg.name).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    expect(pkg.publisher).toMatch(/^[a-z0-9][a-z0-9-]*$/i);
    expect(pkg.displayName).toBe('SetupGuard');
    expect(pkg.engines['vscode']).toBeDefined();
  });

  it('stays private, so no `npm publish` can happen by accident', async () => {
    expect((await manifest()).private).toBe(true);
  });

  it('bundles instead of shipping dependencies', async () => {
    const pkg = await manifest();
    // A VSIX has no `node_modules`. Anything listed as a runtime dependency
    // would be missing at load time, so the bundle is the contract.
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.main).toBe('./out/extension.cjs');
    expect(pkg.scripts['bundle']).toContain('bundle.mjs');
  });

  it('never publishes to a marketplace from a script', async () => {
    const pkg = await manifest();
    for (const [name, script] of Object.entries(pkg.scripts)) {
      expect(script, name).not.toMatch(/\bvsce\s+publish\b/);
      expect(script, name).not.toMatch(/\bovsx\b/);
      expect(script, name).not.toMatch(/\bnpm\s+publish\b/);
    }
  });

  it('registers exactly the commands the code implements', async () => {
    const pkg = await manifest();
    const declared = pkg.contributes.commands.map((command) => command.command).sort();
    expect(declared).toEqual(['setupguard.runDiagnosis', 'setupguard.showReport']);

    const source = await extensionSource();
    for (const command of declared) {
      expect(source, command).toContain(command.replace('setupguard.', ''));
    }
    expect(declared).toContain(SHOW_REPORT_COMMAND);
  });

  it('gives every command the same palette prefix', async () => {
    for (const command of (await manifest()).contributes.commands) {
      expect(command.category).toBe('SetupGuard');
    }
  });

  it('activates on evidence of a project, not on startup', async () => {
    const pkg = await manifest();
    expect(pkg.activationEvents).toEqual([
      'workspaceContains:package.json',
      'workspaceContains:.setupguard.yml',
    ]);
    // `*` would run SetupGuard in every window, including ones it has nothing
    // to say about.
    expect(pkg.activationEvents).not.toContain('*');
    expect(pkg.activationEvents).not.toContain('onStartupFinished');
  });

  it('states its Workspace Trust position explicitly', async () => {
    const { capabilities } = await manifest();
    expect(capabilities.untrustedWorkspaces.supported).toBe(true);
    // Supporting untrusted workspaces is a claim about behaviour, so the reason
    // has to be written down where a reviewer reads it.
    expect(capabilities.untrustedWorkspaces.description).toMatch(/never runs/i);
    expect(capabilities.virtualWorkspaces.supported).toBe(false);
  });

  it('runs where the files are', async () => {
    expect((await manifest()).extensionKind).toEqual(['workspace']);
  });

  it('contributes no settings, because configuration belongs in the repository', async () => {
    const contributes = (await manifest()).contributes as Record<string, unknown>;
    expect(contributes['configuration']).toBeUndefined();
  });
});

describe('extension source boundaries', () => {
  it('is the only module that imports vscode', async () => {
    const dir = path.join(packageRoot, 'src');
    const files = await fs.readdir(dir);

    for (const file of files.filter((name) => name.endsWith('.ts'))) {
      const source = await fs.readFile(path.join(dir, file), 'utf8');
      const importsVsCode = /from '(vscode)'/.test(source);
      expect(importsVsCode, file).toBe(file === 'extension.ts');
    }
  });

  it('starts no process', async () => {
    const dir = path.join(packageRoot, 'src');
    for (const file of (await fs.readdir(dir)).filter((name) => name.endsWith('.ts'))) {
      const source = await fs.readFile(path.join(dir, file), 'utf8');
      expect(source, file).not.toMatch(/child_process|execSync|\bspawn\(/);
      expect(source, file).not.toMatch(/\bfetch\(|https?\.request|XMLHttpRequest/);
    }
  });
});

describe('.vscodeignore', () => {
  it('excludes everything and adds back only what the extension needs', async () => {
    const text = await fs.readFile(path.join(packageRoot, '.vscodeignore'), 'utf8');
    const rules = text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'));

    // An allow-list is the only shape that cannot leak a new directory someone
    // adds later.
    expect(rules[0]).toBe('**');
    expect(rules.slice(1).every((rule) => rule.startsWith('!'))).toBe(true);
    expect(rules).toContain('!out/extension.cjs');

    for (const forbidden of ['src', 'test', 'Notes', 'fixtures', 'node_modules', 'tsconfig']) {
      expect(rules.some((rule) => rule.includes(forbidden)), forbidden).toBe(false);
    }
  });
});
