// Public API: compile-and-run a Quill program, or keep a long-lived session (REPL).

import { QuillError, formatError } from "./errors.js";
import { Interpreter, QuillThrow, type InterpreterOptions } from "./interpreter.js";
import { parse } from "./parser.js";
import { Resolver } from "./resolver.js";
import { stringify, type Value } from "./values.js";

export { QuillError, formatError } from "./errors.js";
export { tokenize, type Token } from "./lexer.js";
export { parse } from "./parser.js";
export { stringify, type Value } from "./values.js";

export type RunResult =
  | { ok: true; value: Value | undefined }
  | { ok: false; error: QuillError; message: string };

/** A persistent session: globals survive between `run` calls, like a REPL. */
export class Session {
  private readonly interpreter: Interpreter;
  private readonly globalConsts = new Set<string>(["PI"]);

  constructor(options: InterpreterOptions = {}) {
    this.interpreter = new Interpreter(options);
    for (const [name] of this.interpreter.globals.vars) this.globalConsts.add(name);
  }

  run(source: string): RunResult {
    try {
      const program = parse(source);
      // Resolve against a copy so a failed line doesn't leave half-registered consts behind.
      const consts = new Set(this.globalConsts);
      new Resolver(consts).resolve(program);
      for (const c of consts) this.globalConsts.add(c);
      this.interpreter.run(program);
      return { ok: true, value: this.interpreter.lastValue };
    } catch (e) {
      const error = toQuillError(e);
      return { ok: false, error, message: formatError(source, error) };
    }
  }
}

/** Run a complete program in a fresh environment. */
export function run(source: string, options: InterpreterOptions = {}): RunResult {
  return new Session(options).run(source);
}

function toQuillError(e: unknown): QuillError {
  if (e instanceof QuillError) return e;
  if (e instanceof QuillThrow) return new QuillError("RuntimeError", `Uncaught ${stringify(e.value, true)}`, e.pos);
  if (e instanceof RangeError) return new QuillError("RuntimeError", "Stack overflow", { line: 1, col: 1 });
  throw e;
}
