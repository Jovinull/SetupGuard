/**
 * Command extraction from Markdown documentation.
 *
 * The goal is precision, not coverage: a false "your README is wrong" costs
 * more trust than a missed one (`Notes/09-seguranca-e-confiabilidade.md`). Only
 * two shapes are treated as executable instructions:
 *
 * - lines inside a fenced code block whose info string is shell-like (or empty);
 * - inline code spans that start with a known package manager.
 *
 * Blocks tagged `json`, `ts`, `yaml`, `diff` and friends are ignored entirely.
 */

export interface DocumentedCommand {
  /** 1-based line in the document. */
  readonly line: number;
  readonly command: string;
  readonly source: 'code-block' | 'inline-code';
}

/**
 * Fences that transcribe a *session*: commands are prefixed with a prompt and
 * everything else is program output. Reading an output line as a command is a
 * false positive waiting to happen, so in these fences only prompted lines
 * count.
 */
const SESSION_LANGUAGES: ReadonlySet<string> = new Set([
  'console',
  'shell-session',
  'shellsession',
  'terminal',
]);

/** Fence info strings treated as shell. An empty info string counts as shell. */
const SHELL_LANGUAGES: ReadonlySet<string> = new Set([
  '',
  'sh',
  'bash',
  'zsh',
  'shell',
  'shell-session',
  'shellsession',
  'console',
  'terminal',
  'command',
  'cmd',
]);

const FENCE = /^(\s{0,3})(`{3,}|~{3,})\s*(\S*)/;
const INLINE_CODE = /`([^`\n]+)`/g;
const PACKAGE_MANAGER_START = /^(?:\$\s*)?(?:npm|pnpm|yarn|bun)\b/;

export function extractDocumentedCommands(markdown: string): DocumentedCommand[] {
  const commands: DocumentedCommand[] = [];
  const lines = markdown.split(/\r?\n/);

  let fenceMarker: string | undefined;
  let fenceIsShell = false;
  let fenceIsSession = false;

  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine ?? '';
    const fence = FENCE.exec(line);

    if (fenceMarker !== undefined) {
      // Inside a fence: only a bare run of the same character, at least as long
      // as the opening marker, closes it.
      if (closesFence(line, fenceMarker)) {
        fenceMarker = undefined;
        fenceIsShell = false;
        fenceIsSession = false;
        continue;
      }
      if (fenceIsShell) {
        const command = normalizeShellLine(line, fenceIsSession);
        if (command) commands.push({ line: index + 1, command, source: 'code-block' });
      }
      continue;
    }

    if (fence?.[2]) {
      const language = (fence[3] ?? '').toLowerCase();
      fenceMarker = fence[2];
      fenceIsShell = SHELL_LANGUAGES.has(language);
      fenceIsSession = SESSION_LANGUAGES.has(language);
      continue;
    }

    for (const match of line.matchAll(INLINE_CODE)) {
      const candidate = (match[1] ?? '').trim();
      if (candidate !== '' && PACKAGE_MANAGER_START.test(candidate)) {
        commands.push({ line: index + 1, command: stripPrompt(candidate), source: 'inline-code' });
      }
    }
  }

  return commands;
}

function closesFence(line: string, openingMarker: string): boolean {
  const trimmed = line.trim();
  const char = openingMarker[0];
  if (char === undefined || trimmed.length < openingMarker.length) return false;
  return [...trimmed].every((current) => current === char);
}

/** Strip prompts and comments; return `undefined` when nothing executable remains. */
function normalizeShellLine(line: string, sessionFence: boolean): string | undefined {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return undefined;
  // In a session transcript the prompt is what separates a command from the
  // output it produced, so an unprompted line there is output and is dropped.
  // In a plain shell fence there is no prompt convention to rely on, and every
  // line is a candidate.
  if (sessionFence && !/^[$>]\s/.test(trimmed)) return undefined;
  return stripPrompt(trimmed);
}

function stripPrompt(value: string): string {
  return value.replace(/^\$\s+/, '').replace(/^>\s+/, '').trim();
}

/** Documentation files scanned by default, relative to the workspace root. */
export const ROOT_DOC_FILES: readonly string[] = [
  'README.md',
  'readme.md',
  'CONTRIBUTING.md',
  'CONTRIBUTING.mdx',
  'AGENTS.md',
  'CLAUDE.md',
  'DEVELOPMENT.md',
  'GETTING_STARTED.md',
  'docs/README.md',
  '.github/CONTRIBUTING.md',
];
