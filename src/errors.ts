export type ErrorKind = "SyntaxError" | "ScopeError" | "RuntimeError";

export interface Position {
  line: number; // 1-based
  col: number;  // 1-based
}

/** Every error Quill reports carries a source position for a caret diagnostic. */
export class QuillError extends Error {
  constructor(
    readonly kind: ErrorKind,
    message: string,
    readonly pos: Position,
  ) {
    super(message);
  }
}

/**
 * Render an error like a compiler would:
 *
 *   RuntimeError: Cannot add string and number
 *    --> line 3, col 13
 *     |
 *   3 | let total = "a" + 1;
 *     |             ^
 */
export function formatError(source: string, err: QuillError): string {
  const lines = source.split("\n");
  const { line, col } = err.pos;
  const text = lines[line - 1] ?? "";
  const gutter = String(line).length;
  const pad = " ".repeat(gutter);
  return [
    `${err.kind}: ${err.message}`,
    `${pad}--> line ${line}, col ${col}`,
    `${pad} |`,
    `${line} | ${text.replace(/\t/g, " ")}`,
    `${pad} | ${" ".repeat(Math.max(0, col - 1))}^`,
  ].join("\n");
}
