import { randomBytes } from 'node:crypto';

/**
 * Everything the action writes that the Actions runner interprets.
 *
 * The runner scans stdout for lines starting with `::` and treats them as
 * commands. Every string the action prints — file names, script names, messages
 * built from README lines — can come from the pull request, which means from
 * whoever opened it. Two rules keep that text inert:
 *
 * 1. Values inside a command are escaped the way the runner unescapes them
 *    (the same rules as `@actions/core`), so a message cannot end the command
 *    early or start a new line.
 * 2. Free-form log output is printed between `::stop-commands::<token>` and
 *    `::<token>::`, with a token generated per run. Inside that region the
 *    runner ignores commands entirely, so even a line that somehow starts with
 *    `::` is just text.
 */

/** Escape the message part of a workflow command. */
export function escapeData(value: string): string {
  return value.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/** Escape a property value (`file=`, `title=`, ...), where `:` and `,` are also syntax. */
export function escapeProperty(value: string): string {
  return escapeData(value).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

export type AnnotationLevel = 'error' | 'warning' | 'notice';

export interface Annotation {
  readonly level: AnnotationLevel;
  readonly message: string;
  readonly title?: string;
  readonly file?: string;
  readonly line?: number;
  readonly endLine?: number;
  readonly col?: number;
  readonly endColumn?: number;
}

/** Render one annotation as a single workflow-command line. */
export function formatAnnotation(annotation: Annotation): string {
  const properties: string[] = [];
  if (annotation.title !== undefined) properties.push(`title=${escapeProperty(annotation.title)}`);
  if (annotation.file !== undefined) {
    properties.push(`file=${escapeProperty(annotation.file)}`);
    // Positions are only meaningful with a file, and only when they are real
    // positive integers. Anything else is dropped rather than guessed.
    const position: Array<[string, number | undefined]> = [
      ['line', annotation.line],
      ['endLine', annotation.endLine],
      ['col', annotation.col],
      ['endColumn', annotation.endColumn],
    ];
    for (const [name, value] of position) {
      if (value !== undefined && Number.isSafeInteger(value) && value > 0) {
        properties.push(`${name}=${value}`);
      }
    }
  }
  const head = properties.length > 0 ? `${annotation.level} ${properties.join(',')}` : annotation.level;
  return `::${head}::${escapeData(annotation.message)}`;
}

/** A random token for `stop-commands`, unique per run as the runner docs require. */
export function newStopToken(): string {
  return `setupguard-${randomBytes(16).toString('hex')}`;
}

/**
 * Wrap untrusted, free-form log text so the runner cannot interpret any of it.
 *
 * The text is also flattened: carriage returns become `\n` and other control
 * characters are dropped, so nothing can rewrite a previous log line.
 */
export function inertBlock(text: string, token: string): string {
  // eslint-disable-next-line no-control-regex -- removing control characters is the point
  const cleaned = text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, ' ');
  return `::stop-commands::${token}\n${cleaned}\n::${token}::`;
}

/**
 * Render `name=value` lines for `$GITHUB_OUTPUT`.
 *
 * Only for values this action computes (enums and counts). They are checked
 * here so a future caller cannot pass arbitrary text through the simple form,
 * where a newline would start another output.
 */
export function formatOutputs(outputs: Readonly<Record<string, string | number>>): string {
  return Object.entries(outputs)
    .map(([name, value]) => {
      const text = String(value);
      if (!/^[A-Za-z0-9_-]+$/.test(name) || !/^[A-Za-z0-9_.-]*$/.test(text)) {
        throw new Error(`Refusing to write a non-trivial output value for "${name}"`);
      }
      return `${name}=${text}\n`;
    })
    .join('');
}
