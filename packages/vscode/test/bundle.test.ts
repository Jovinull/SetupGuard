import { createRequire } from 'node:module';
import Module from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { fixture } from '@setupguard/testing';

/**
 * Tests the artifact that ships, not the sources it came from.
 *
 * `out/extension.cjs` is produced by `pnpm --filter setupguard run bundle`, so
 * this file skips when the bundle is absent and runs in CI right after
 * packaging. Everything else in this package tests modules that never see the
 * Extension Host; this is the one place the entry point is actually loaded and
 * activated.
 *
 * The `vscode` module is replaced by the smallest object that lets activation
 * complete. That is not a stand-in for the editor and proves nothing about how
 * VS Code renders anything — what it proves is narrower and worth having: the
 * bundle loads as CommonJS, activation and disposal do not throw, a real
 * diagnosis runs to completion through it, and the whole path requires no
 * module that could start a process or open a socket.
 */

const packageRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const bundlePath = path.join(packageRoot, 'out', 'extension.cjs');

/** Anything here would contradict "reads files, runs nothing, sends nothing". */
const FORBIDDEN_MODULES = [
  'child_process',
  'cluster',
  'http',
  'https',
  'http2',
  'net',
  'tls',
  'dgram',
  'worker_threads',
  'vm',
  'inspector',
];

/**
 * `this: void` on every member: these are plain functions pulled off a module
 * object and out of a disposables array, never bound methods.
 */
interface Disposable {
  dispose?(this: void): void;
}

interface Harness {
  activate(this: void, context: { subscriptions: Disposable[] }): void;
  deactivate(this: void): void;
}

interface Capture {
  readonly statusTexts: string[];
  readonly diagnostics: Map<string, unknown[]>;
  readonly commands: Record<string, () => unknown>;
  readonly logs: string[];
  requiredModules: Set<string>;
  reportText(): string;
}

function loadBundle(folders: { name: string; fsPath: string }[]): {
  extension: Harness;
  capture: Capture;
  restore(this: void): void;
} {
  const statusTexts: string[] = [];
  const diagnostics = new Map<string, unknown[]>();
  const commands: Record<string, () => unknown> = {};
  const logs: string[] = [];
  const requiredModules = new Set<string>();
  let provider: { provideTextDocumentContent(): string } | undefined;

  const uri = (fsPath: string): Record<string, unknown> => ({
    scheme: 'file',
    fsPath,
    path: fsPath,
    toString: () => `file://${fsPath}`,
  });

  const vscodeStub = {
    StatusBarAlignment: { Left: 1, Right: 2 },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    Uri: {
      parse: (value: string) => ({ toString: () => value }),
      joinPath: (base: { fsPath: string }, ...parts: string[]) => uri(path.join(base.fsPath, ...parts)),
    },
    RelativePattern: class {
      constructor(
        readonly base: unknown,
        readonly pattern: string,
      ) {}
    },
    EventEmitter: class {
      event = (): { dispose(): void } => ({ dispose() {} });
      fire(): void {}
      dispose(): void {}
    },
    Range: class {
      constructor(...args: number[]) {
        Object.assign(this, { args });
      }
    },
    Diagnostic: class {
      constructor(
        readonly range: unknown,
        readonly message: string,
        readonly severity: number,
      ) {}
    },
    ThemeColor: class {
      constructor(readonly id: string) {}
    },
    languages: {
      createDiagnosticCollection: () => ({
        clear: () => diagnostics.clear(),
        set: (target: { fsPath: string }, value: unknown[]) => diagnostics.set(target.fsPath, value),
        dispose() {},
      }),
    },
    window: {
      createOutputChannel: () => ({ appendLine: (line: string) => logs.push(line), dispose() {} }),
      createStatusBarItem: () => ({
        show() {},
        dispose() {},
        set text(value: string) {
          statusTexts.push(value);
        },
        set tooltip(_value: string) {},
        set command(_value: string) {},
        set name(_value: string) {},
        set backgroundColor(_value: unknown) {},
      }),
      showTextDocument: () => Promise.resolve({}),
    },
    workspace: {
      workspaceFolders: folders.map((folder) => ({ name: folder.name, uri: uri(folder.fsPath) })),
      onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
      registerTextDocumentContentProvider: (_scheme: string, value: typeof provider) => {
        provider = value;
        return { dispose() {} };
      },
      openTextDocument: () => Promise.resolve({}),
      createFileSystemWatcher: () => ({
        onDidCreate: () => ({ dispose() {} }),
        onDidChange: () => ({ dispose() {} }),
        onDidDelete: () => ({ dispose() {} }),
        dispose() {},
      }),
      asRelativePath: (value: { fsPath: string }) => value.fsPath,
    },
    commands: {
      registerCommand: (id: string, handler: () => unknown) => {
        commands[id] = handler;
        return { dispose() {} };
      },
    },
  };

  // Written as a property rather than a method so `this` is explicit: the
  // original loader is called back with the receiver it was given.
  const loader = Module as unknown as {
    _load: (this: unknown, request: string, parent: unknown, isMain: boolean) => unknown;
  };
  const original = loader._load;
  loader._load = function patched(
    this: unknown,
    request: string,
    parent: unknown,
    isMain: boolean,
  ): unknown {
    requiredModules.add(request);
    if (request === 'vscode') return vscodeStub;
    return original.call(this, request, parent, isMain);
  };

  const require = createRequire(import.meta.url);
  delete require.cache[require.resolve(bundlePath)];
  const extension = require(bundlePath) as Harness;

  return {
    extension,
    capture: {
      statusTexts,
      diagnostics,
      commands,
      logs,
      requiredModules,
      reportText: () => provider?.provideTextDocumentContent() ?? '',
    },
    restore: () => {
      loader._load = original;
    },
  };
}

/** Wait until the status bar stops showing the spinner, or give up. */
async function settle(capture: Capture): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const last = capture.statusTexts[capture.statusTexts.length - 1];
    if (last !== undefined && !last.includes('sync~spin')) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe.skipIf(!existsSync(bundlePath))('the packaged bundle', () => {
  it('loads as CommonJS and exposes the extension entry points', () => {
    const { extension, restore } = loadBundle([]);
    try {
      expect(typeof extension.activate).toBe('function');
      expect(typeof extension.deactivate).toBe('function');
    } finally {
      restore();
    }
  });

  it('activates, diagnoses a real project and disposes cleanly', async () => {
    const { extension, capture, restore } = loadBundle([
      { name: 'broken', fsPath: fixture('broken-node-project') },
    ]);
    const subscriptions: Disposable[] = [];

    try {
      extension.activate({ subscriptions });
      await settle(capture);

      expect(capture.statusTexts.at(-1)).toBe('$(error) SetupGuard: Blocked');
      expect([...capture.diagnostics.keys()].some((file) => file.endsWith('package.json'))).toBe(true);
      expect(capture.reportText()).toContain('BLOCKED');
      expect(capture.commands['setupguard.runDiagnosis']).toBeTypeOf('function');
      expect(capture.commands['setupguard.showReport']).toBeTypeOf('function');

      for (const subscription of subscriptions) subscription.dispose?.();
      extension.deactivate();
    } finally {
      restore();
    }
  });

  it('requires no module that could start a process or open a socket', async () => {
    const { extension, capture, restore } = loadBundle([
      { name: 'healthy', fsPath: fixture('healthy-pnpm') },
    ]);
    const subscriptions: Disposable[] = [];

    try {
      extension.activate({ subscriptions });
      await settle(capture);

      const required = [...capture.requiredModules].map((name) => name.replace(/^node:/, ''));
      for (const forbidden of FORBIDDEN_MODULES) {
        expect(required, forbidden).not.toContain(forbidden);
      }

      for (const subscription of subscriptions) subscription.dispose?.();
    } finally {
      restore();
    }
  });

  it('logs the outcome without quoting repository content', async () => {
    const { extension, capture, restore } = loadBundle([
      { name: 'secrets', fsPath: fixture('secret-env') },
    ]);
    const subscriptions: Disposable[] = [];

    try {
      extension.activate({ subscriptions });
      await settle(capture);

      const log = capture.logs.join('\n');
      expect(log).toContain('secrets: run 1 finished');
      expect(log).not.toContain('QA-FAKE-CREDENTIAL-0003');

      for (const subscription of subscriptions) subscription.dispose?.();
    } finally {
      restore();
    }
  });
});
