import * as vscode from 'vscode';

import { nodeAdapter } from '@setupguard/adapter-node';
import {
  AdapterRegistry,
  NodeEnvironmentProbe,
  NodeWorkspaceFs,
  describeError,
  loadConfig,
  runDiagnosis,
  type Report,
  type Severity,
} from '@setupguard/core';

import {
  DIAGNOSTIC_SEVERITY,
  toConfigDiagnostics,
  toDiagnostics,
  type DiagnosticSeverity,
  type EditorDiagnostic,
} from './diagnostics.js';
import { renderReports } from './report-view.js';
import { DiagnosisSession, type SessionState } from './session.js';
import { SHOW_REPORT_COMMAND, toStatusBarState, type StatusInput } from './status.js';
import { WATCH_GLOBS, shouldTriggerRun } from './watch-patterns.js';

/**
 * The only module in this package that imports `vscode`.
 *
 * Everything with a decision in it — what the status bar says, when a run is
 * worth starting, which result may be published, how a report reads — lives in
 * the sibling modules and is unit-tested without an Extension Host. What is
 * left here is wiring: create the VS Code objects, hand them the pure results,
 * dispose of them.
 *
 * Activating this extension runs no project code. See
 * `Notes/16-extensao-vscode-implementada.md`.
 */

const RUN_COMMAND = 'setupguard.runDiagnosis';
const REPORT_SCHEME = 'setupguard-report';
const REPORT_URI = vscode.Uri.parse(`${REPORT_SCHEME}:SetupGuard.txt`);

/** Quiet period after a file event. Long enough to swallow a checkout or an install. */
const DEBOUNCE_MS = 750;

/** Findings with no file of their own are anchored to the manifest. */
const UNPLACED_ANCHOR = 'package.json';

const UNPLACED_SEVERITY: Record<Severity, DiagnosticSeverity> = {
  error: DIAGNOSTIC_SEVERITY.Error,
  warning: DIAGNOSTIC_SEVERITY.Warning,
  info: DIAGNOSTIC_SEVERITY.Information,
};

const SEVERITY_TO_VSCODE: Record<DiagnosticSeverity, vscode.DiagnosticSeverity> = {
  [DIAGNOSTIC_SEVERITY.Error]: vscode.DiagnosticSeverity.Error,
  [DIAGNOSTIC_SEVERITY.Warning]: vscode.DiagnosticSeverity.Warning,
  [DIAGNOSTIC_SEVERITY.Information]: vscode.DiagnosticSeverity.Information,
  [DIAGNOSTIC_SEVERITY.Hint]: vscode.DiagnosticSeverity.Hint,
};

export function activate(context: vscode.ExtensionContext): void {
  const extension = new SetupGuardExtension();
  context.subscriptions.push(extension);
  extension.start(context);
}

export function deactivate(): void {
  // Everything is registered in `context.subscriptions`; VS Code disposes it.
}

class SetupGuardExtension implements vscode.Disposable {
  readonly #diagnostics = vscode.languages.createDiagnosticCollection('setupguard');
  readonly #output = vscode.window.createOutputChannel('SetupGuard');
  readonly #statusBar = vscode.window.createStatusBarItem(
    'setupguard.status',
    vscode.StatusBarAlignment.Right,
    100,
  );
  readonly #reportProvider = new ReportDocumentProvider();
  readonly #folders = new Map<string, FolderController>();
  #disposed = false;

  start(context: vscode.ExtensionContext): void {
    this.#statusBar.name = 'SetupGuard';

    context.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider(REPORT_SCHEME, this.#reportProvider),
      vscode.commands.registerCommand(RUN_COMMAND, () => {
        this.#log('Manual run requested.');
        for (const controller of this.#folders.values()) controller.session.runNow();
        this.#render();
      }),
      vscode.commands.registerCommand(SHOW_REPORT_COMMAND, () => this.#showReport()),
      vscode.workspace.onDidChangeWorkspaceFolders((event) => {
        for (const removed of event.removed) this.#removeFolder(removed);
        for (const added of event.added) this.#addFolder(added);
        this.#render();
      }),
    );

    for (const folder of vscode.workspace.workspaceFolders ?? []) this.#addFolder(folder);
    this.#render();
  }

  dispose(): void {
    this.#disposed = true;
    for (const controller of this.#folders.values()) controller.dispose();
    this.#folders.clear();
    this.#diagnostics.dispose();
    this.#statusBar.dispose();
    this.#output.dispose();
    this.#reportProvider.dispose();
  }

  #addFolder(folder: vscode.WorkspaceFolder): void {
    const key = folder.uri.toString();
    if (this.#folders.has(key)) return;

    // `virtualWorkspaces` is declared unsupported, so anything that is not a
    // real path is a situation we have not verified. Skipping is honest;
    // pretending to analyse it would not be.
    if (folder.uri.scheme !== 'file') {
      this.#log(`Skipping ${folder.name}: SetupGuard only analyses folders on a real filesystem.`);
      return;
    }

    const controller = new FolderController(folder, {
      debounceMs: DEBOUNCE_MS,
      onStateChange: () => this.#render(),
      log: (message) => this.#log(message),
    });
    this.#folders.set(key, controller);
    controller.session.request();
  }

  #removeFolder(folder: vscode.WorkspaceFolder): void {
    const key = folder.uri.toString();
    const controller = this.#folders.get(key);
    if (!controller) return;
    controller.dispose();
    this.#folders.delete(key);
  }

  /** Rebuild every VS Code surface from the sessions' current state. */
  #render(): void {
    if (this.#disposed) return;
    try {
      this.#publishDiagnostics();
      this.#updateStatusBar();
      this.#reportProvider.update(this.#renderReport());
    } catch (error) {
      // This runs inside the session's state callback, so an exception would
      // escape as an unhandled rejection and leave the editor showing whatever
      // it happened to be showing, with nothing said about why. Redacted like
      // every other message, because it can quote a path.
      this.#log(`Could not update the editor: ${describeError(error)}`);
    }
  }

  /**
   * Republish the whole collection rather than patching it.
   *
   * A finding can move between files, disappear, or belong to a folder that was
   * just removed. Rebuilding from the current reports is the only way to be
   * sure the Problems panel never shows a stale entry, and the data is small.
   */
  #publishDiagnostics(): void {
    this.#diagnostics.clear();

    for (const controller of this.#folders.values()) {
      const report = controller.session.state.report;
      if (!report) continue;

      const projection = toDiagnostics(report);
      const byFile = new Map<string, vscode.Diagnostic[]>();

      for (const diagnostic of [...projection.diagnostics, ...toConfigDiagnostics(report)]) {
        push(byFile, diagnostic.file, toVsCodeDiagnostic(diagnostic));
      }

      // Findings that name no file still have to be visible somewhere, or a
      // "Blocked" status bar would point at an empty Problems panel.
      for (const finding of projection.unplaced) {
        push(
          byFile,
          UNPLACED_ANCHOR,
          toVsCodeDiagnostic({
            file: UNPLACED_ANCHOR,
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            severity: UNPLACED_SEVERITY[finding.severity],
            message: finding.message,
            code: finding.code,
            source: 'SetupGuard',
            checkId: finding.checkId,
          }),
        );
      }

      for (const [file, diagnostics] of byFile) {
        this.#diagnostics.set(vscode.Uri.joinPath(controller.folder.uri, ...file.split('/')), diagnostics);
      }
    }
  }

  #updateStatusBar(): void {
    const state = toStatusBarState(this.#statusInput());
    this.#statusBar.text = state.text;
    this.#statusBar.tooltip = state.tooltip;
    this.#statusBar.command = state.command;
    this.#statusBar.backgroundColor =
      state.background === 'none'
        ? undefined
        : new vscode.ThemeColor(`statusBarItem.${state.background}Background`);
    this.#statusBar.show();
  }

  #statusInput(): StatusInput {
    const states = [...this.#folders.values()].map((controller) => controller.session.state);
    if (states.length === 0) return { phase: 'settled', reports: [], noWorkspace: true };

    const reports = states.map((state) => state.report).filter((report): report is Report => !!report);
    const error = states.map((state) => state.error).find((message) => message !== undefined);
    const phase: SessionState['phase'] = states.some((state) => state.phase === 'running')
      ? 'running'
      : states.every((state) => state.phase === 'settled')
        ? 'settled'
        : 'idle';

    return { phase, reports, ...(error !== undefined ? { error } : {}) };
  }

  #renderReport(): string {
    const entries: { label: string; report: Report }[] = [];
    for (const controller of this.#folders.values()) {
      const report = controller.session.state.report;
      if (report) entries.push({ label: controller.folder.name, report });
    }
    return renderReports(entries);
  }

  async #showReport(): Promise<void> {
    this.#reportProvider.update(this.#renderReport());
    const document = await vscode.workspace.openTextDocument(REPORT_URI);
    await vscode.window.showTextDocument(document, { preview: true, preserveFocus: false });
  }

  /**
   * Lifecycle logging only.
   *
   * Report content is never written here: it is already on screen through the
   * Problems panel and the report document, and an output channel is one more
   * place a value could end up quoted.
   */
  #log(message: string): void {
    this.#output.appendLine(`[${new Date().toISOString()}] ${message}`);
  }
}

interface FolderControllerOptions {
  readonly debounceMs: number;
  onStateChange(): void;
  log(message: string): void;
}

/** One workspace folder: its own filesystem view, session and watchers. */
class FolderController implements vscode.Disposable {
  readonly folder: vscode.WorkspaceFolder;
  readonly session: DiagnosisSession;
  readonly #watchers: vscode.Disposable[] = [];

  constructor(folder: vscode.WorkspaceFolder, options: FolderControllerOptions) {
    this.folder = folder;

    this.session = new DiagnosisSession({
      debounceMs: options.debounceMs,
      describeError,
      schedule: (callback, delayMs) => {
        const handle = setTimeout(callback, delayMs);
        return () => {
          clearTimeout(handle);
        };
      },
      onStateChange: (state) => {
        if (state.phase === 'settled') {
          options.log(
            state.error !== undefined
              ? `${folder.name}: run ${state.generation} failed — ${state.error}`
              : `${folder.name}: run ${state.generation} finished — ${state.report?.readiness ?? 'unknown'}`,
          );
        }
        options.onStateChange();
      },
      run: (signal) => this.#run(signal),
    });

    for (const glob of WATCH_GLOBS) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(folder, glob),
      );
      const onEvent = (uri: vscode.Uri): void => {
        const relative = vscode.workspace.asRelativePath(uri, false);
        if (!shouldTriggerRun(relative)) return;
        this.session.request();
      };
      this.#watchers.push(
        watcher,
        watcher.onDidCreate(onEvent),
        watcher.onDidChange(onEvent),
        watcher.onDidDelete(onEvent),
      );
    }
  }

  dispose(): void {
    this.session.dispose();
    for (const watcher of this.#watchers) watcher.dispose();
    this.#watchers.length = 0;
  }

  /**
   * One diagnosis, wired exactly like the CLI's.
   *
   * Same engine, same adapters, same levels: `static` and `environment`, which
   * read repository files and inspect the local machine and start no process.
   * The extension adds no capability the command line does not have.
   */
  async #run(signal: AbortSignal): Promise<Report> {
    const workspace = new NodeWorkspaceFs(this.folder.uri.fsPath);
    const registry = new AdapterRegistry([nodeAdapter]);

    const config = await loadConfig({
      fs: workspace,
      knownCheckIds: registry.list().flatMap((adapter) => adapter.checks.map((check) => check.id)),
    });

    return runDiagnosis({
      fs: workspace,
      environment: new NodeEnvironmentProbe(),
      registry,
      config,
      signal,
    });
  }
}

/** Serves the report as a read-only virtual document. No WebView, no HTML. */
class ReportDocumentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  readonly #emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.#emitter.event;
  #content = '';

  provideTextDocumentContent(): string {
    return this.#content;
  }

  update(content: string): void {
    if (content === this.#content) return;
    this.#content = content;
    this.#emitter.fire(REPORT_URI);
  }

  dispose(): void {
    this.#emitter.dispose();
  }
}

function toVsCodeDiagnostic(diagnostic: EditorDiagnostic): vscode.Diagnostic {
  const range = new vscode.Range(
    diagnostic.range.start.line,
    diagnostic.range.start.character,
    diagnostic.range.end.line,
    // `Number.MAX_SAFE_INTEGER` means "to the end of the line"; VS Code clamps
    // it, but only within the range of a 32-bit position.
    Math.min(diagnostic.range.end.character, 0x7fffffff),
  );
  const created = new vscode.Diagnostic(range, diagnostic.message, SEVERITY_TO_VSCODE[diagnostic.severity]);
  created.source = diagnostic.source;
  created.code = diagnostic.code;
  return created;
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}
