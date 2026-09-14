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

  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine ?? '';
    const fence = FENCE.exec(line);

    if (fenceMarker !== undefined) {
      // Inside a fence: only a bare run of the same character, at least as long
      // as the opening marker, closes it.
      if (closesFence(line, fenceMarker)) {
        fenceMarker = undefined;
        fenceIsShell = false;
        continue;
      }
      if (fenceIsShell) {
        const command = normalizeShellLine(line);
        if (command) commands.push({ line: index + 1, command, source: 'code-block' });
      }
      continue;
    }

    if (fence?.[2]) {
      fenceMarker = fence[2];
      fenceIsShell = SHELL_LANGUAGES.has((fence[3] ?? '').toLowerCase());
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
function normalizeShellLine(line: string): string | undefined {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return undefined;
  // Shell-session transcripts prefix output lines with nothing and commands
  // with `$` or `>`; without a prompt we cannot tell output from command, so we
  // keep the line and let the reference parser reject anything unrecognised.
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
