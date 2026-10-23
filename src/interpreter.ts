// Tree-walking interpreter.
//
// Control flow (break / continue / return) is signalled with completion codes
// returned from `exec`, not exceptions, so loops and calls stay fast. Only
// `throw` and runtime errors unwind via JS exceptions, which is what lets
// Quill's try/catch catch them.

import type { Expr, FunctionExpr, Program, Stmt, BinaryOp, AssignOp } from "./ast.js";
import { QuillError, type Position } from "./errors.js";
import { createGlobals } from "./builtins.js";
import {
  Callable, Environment, QuillFunction, type Interp, type Key, type Value,
  equals, isKey, isTruthy, stringify, typeOf,
} from "./values.js";

const enum Completion { Normal, Break, Continue, Return }

/** A value thrown by Quill code (`throw x`) travelling up the JS stack. */
export class QuillThrow extends Error {
  constructor(readonly value: Value, readonly pos: Position) {
    super(`Uncaught ${stringify(value, true)}`);
  }
}

export interface InterpreterOptions {
  /** Called once per print() line. Defaults to console.log. */
  print?: (line: string) => void;
  /** Abort after this many loop iterations + calls (guards against infinite loops). */
  maxSteps?: number;
  /** Maximum Quill call depth before reporting a stack overflow. */
  maxDepth?: number;
}

export class Interpreter implements Interp {
  readonly globals: Environment;
  private env: Environment;
  private returnValue: Value = null;
  private steps = 0;
  private depth = 0;
  private readonly maxSteps: number;
  private readonly maxDepth: number;
  /** The value of the last top-level expression statement (shown by the REPL). */
  lastValue: Value | undefined = undefined;

  constructor(options: InterpreterOptions = {}) {
    this.maxSteps = options.maxSteps ?? Infinity;
    this.maxDepth = options.maxDepth ?? 1000;
    this.globals = createGlobals(options.print ?? ((s) => console.log(s)));
    this.env = this.globals;
  }

  run(program: Program): void {
    this.lastValue = undefined;
    this.steps = 0;
    this.hoist(program, this.globals);
    for (const stmt of program) {
      if (stmt.kind === "Expression") {
        this.lastValue = this.eval(stmt.expr);
      } else {
        this.lastValue = undefined;
        this.exec(stmt);
      }
    }
  }

  private error(message: string, pos: Position): never {
    throw new QuillError("RuntimeError", message, pos);
  }

  private tick(pos: Position): void {
    if (++this.steps > this.maxSteps) {
      this.error(`Execution limit exceeded (${this.maxSteps.toLocaleString("en-US")} steps). Is there an infinite loop?`, pos);
    }
  }

  // ---------- statements ----------

  private hoist(body: Stmt[], env: Environment): void {
    for (const s of body) {
      if (s.kind === "FnDecl") env.define(s.fn.name!, this.makeFunction(s.fn, env));
    }
  }

  /** Run statements in `env`, restoring the previous environment afterwards. */
  private execBlock(body: Stmt[], env: Environment): Completion {
    const previous = this.env;
    this.env = env;
    try {
      this.hoist(body, env);
      for (const stmt of body) {
        const c = this.exec(stmt);
        if (c !== Completion.Normal) return c;
      }
      return Completion.Normal;
    } finally {
      this.env = previous;
    }
  }

  private exec(s: Stmt): Completion {
    switch (s.kind) {
      case "Expression":
        this.eval(s.expr);
        return Completion.Normal;

      case "Let":
        this.env.define(s.name, s.init ? this.eval(s.init) : null, s.isConst);
        return Completion.Normal;

      case "Block":
        if (s.scoped === false) {
          for (const stmt of s.body) {
            const c = this.exec(stmt);
            if (c !== Completion.Normal) return c;
          }
          return Completion.Normal;
        }
        return this.execBlock(s.body, new Environment(this.env));

      case "If":
        if (isTruthy(this.eval(s.test))) return this.exec(s.then);
        return s.otherwise ? this.exec(s.otherwise) : Completion.Normal;

      case "While":
        while (isTruthy(this.eval(s.test))) {
          this.tick(s.pos);
          const c = this.exec(s.body);
          if (c === Completion.Break) break;
          if (c === Completion.Return) return c;
        }
        return Completion.Normal;

      case "For": {
        const iterable = this.eval(s.iterable);
        const body = s.body.kind === "Block" ? s.body.body : [s.body];
        for (const item of this.iterate(iterable, s.iterable.pos)) {
          this.tick(s.pos);
          const env = new Environment(this.env); // fresh binding per iteration, so closures capture each value
          env.define(s.name, item);
          const c = this.execBlock(body, env);
          if (c === Completion.Break) break;
          if (c === Completion.Return) return c;
        }
        return Completion.Normal;
      }

      case "Return":
        this.returnValue = s.value ? this.eval(s.value) : null;
        return Completion.Return;

      case "Break": return Completion.Break;
      case "Continue": return Completion.Continue;
      case "FnDecl": return Completion.Normal; // already hoisted

      case "Throw":
        throw new QuillThrow(this.eval(s.value), s.pos);

      case "Try": {
        const saved = { env: this.env, depth: this.depth };
        try {
          return this.exec(s.body);
        } catch (e) {
          const caught = this.toCatchValue(e);
          if (caught === undefined) throw e;
          Object.assign(this, saved); // unwind to the try's frame
          const env = new Environment(this.env);
          env.define(s.name, caught);
          const handler = s.handler.kind === "Block" ? s.handler.body : [s.handler];
          return this.execBlock(handler, env);
        }
      }
    }
  }

  /** Map a JS exception to the value a Quill `catch` receives, or undefined to rethrow. */
  private toCatchValue(e: unknown): Value | undefined {
    if (e instanceof QuillThrow) return e.value;
    if (e instanceof QuillError && e.kind === "RuntimeError" && !e.message.startsWith("Execution limit")) {
      return new Map<Key, Value>([["message", e.message], ["line", e.pos.line], ["col", e.pos.col]]);
    }
    return undefined;
  }

  private *iterate(v: Value, pos: Position): Iterable<Value> {
    if (Array.isArray(v)) {
      // Iterate over a snapshot so mutating the list inside the loop is safe.
      yield* [...v];
    } else if (typeof v === "string") {
      yield* [...v];
    } else if (v instanceof Map) {
      yield* [...v.keys()];
    } else {
      this.error(`Cannot iterate over a ${typeOf(v)}`, pos);
    }
  }

  // ---------- expressions ----------

  // `eval` sits on the recursion path of every nested expression and call, so
  // it is kept deliberately small: V8 sizes a stack frame by the function's
  // locals, and smaller frames let Quill programs recurse deeper. Bulkier,
  // non-recursive cases live in helper methods below.
  eval(e: Expr): Value {
    switch (e.kind) {
      case "Literal": return e.value;
      case "Variable": return this.lookup(e.name, e.depth, e.pos);
      case "Binary": return this.binary(e.op, this.eval(e.left), this.eval(e.right), e.pos);
      case "Conditional": return isTruthy(this.eval(e.test)) ? this.eval(e.then) : this.eval(e.otherwise);
      case "Call": return this.call(this.eval(e.callee), this.evalArgs(e.args), e.pos);
      case "Index": return this.index(this.eval(e.object), this.eval(e.index), e.pos);
      case "Logical": return this.logical(e.op, e.left, e.right);
      case "Unary": return this.unary(e.op, this.eval(e.operand), e.pos);
      case "Assign": return this.assign(e);
      case "SetIndex": return this.setIndex(e);
      case "Template": return this.template(e.strings, e.exprs);
      case "List": return this.evalArgs(e.items);
      case "Map": return this.mapLiteral(e.entries);
      case "Function": return this.makeFunction(e, this.env);
    }
  }

  private evalArgs(exprs: Expr[]): Value[] {
    const out = new Array<Value>(exprs.length);
    for (let i = 0; i < exprs.length; i++) out[i] = this.eval(exprs[i]);
    return out;
  }

  private logical(op: "and" | "or", leftExpr: Expr, rightExpr: Expr): Value {
    const left = this.eval(leftExpr);
    if (op === "or") return isTruthy(left) ? left : this.eval(rightExpr);
    return isTruthy(left) ? this.eval(rightExpr) : left;
  }

  private unary(op: "-" | "!" | "not", v: Value, pos: Position): Value {
    if (op !== "-") return !isTruthy(v);
    if (typeof v !== "number") this.error(`Cannot negate a ${typeOf(v)}`, pos);
    return -v;
  }

  private template(strings: string[], exprs: Expr[]): string {
    let out = strings[0];
    for (let i = 0; i < exprs.length; i++) out += stringify(this.eval(exprs[i])) + strings[i + 1];
    return out;
  }

  private assign(e: Expr & { kind: "Assign" }): Value {
    const env = e.depth === undefined ? this.globals : this.env.ancestor(e.depth);
    if (!env.vars.has(e.name)) this.error(`Undefined variable '${e.name}'`, e.pos);
    if (env.isConst(e.name)) this.error(`Cannot assign to const '${e.name}'`, e.pos);
    const value = e.op === "="
      ? this.eval(e.value)
      : this.arith(compoundOp(e.op), env.vars.get(e.name)!, this.eval(e.value), e.pos);
    env.vars.set(e.name, value);
    return value;
  }

  private setIndex(e: Expr & { kind: "SetIndex" }): Value {
    const object = this.eval(e.object);
    const key = this.eval(e.index);
    const rhs = this.eval(e.value);
    const value = e.op === "=" ? rhs : this.arith(compoundOp(e.op), this.index(object, key, e.pos), rhs, e.pos);
    if (Array.isArray(object)) {
      object[this.listIndex(object, key, e.pos)] = value;
    } else if (object instanceof Map) {
      if (!isKey(key)) this.error(`A ${typeOf(key)} cannot be used as a map key`, e.pos);
      object.set(key, value);
    } else {
      this.error(`Cannot assign into a ${typeOf(object)}`, e.pos);
    }
    return value;
  }

  private mapLiteral(entries: [Expr, Expr][]): Map<Key, Value> {
    const map = new Map<Key, Value>();
    for (const [k, v] of entries) {
      const key = this.eval(k);
      if (!isKey(key)) this.error(`A ${typeOf(key)} cannot be used as a map key`, k.pos);
      map.set(key, this.eval(v));
    }
    return map;
  }

  private lookup(name: string, depth: number | undefined, pos: Position): Value {
    const env = depth === undefined ? this.globals : this.env.ancestor(depth);
    const value = env.vars.get(name);
    if (value === undefined) this.error(`Undefined variable '${name}'`, pos);
    return value;
  }

  private makeFunction(decl: FunctionExpr, closure: Environment): QuillFunction {
    return new QuillFunction(decl, closure, (fn, args, pos) => this.invoke(fn, args, pos));
  }

  call(callee: Value, args: Value[], pos: Position): Value {
    if (!(callee instanceof Callable)) this.error(`Cannot call a ${typeOf(callee)}`, pos);
    const [min, max] = callee.arity();
    if (args.length < min || args.length > max) {
      const expected = min === max ? `${min}` : max === Infinity ? `at least ${min}` : `${min} to ${max}`;
      this.error(`${callee.name}() expects ${expected} argument${expected === "1" ? "" : "s"}, got ${args.length}`, pos);
    }
    // Invoke Quill functions directly rather than through callee.call(): every
    // host stack frame per Quill call reduces how deep Quill programs can recurse.
    if (callee instanceof QuillFunction) return this.invoke(callee, args, pos);
    return callee.call(this, args, pos);
  }

  private invoke(fn: QuillFunction, args: Value[], pos: Position): Value {
    this.tick(pos);
    if (this.depth >= this.maxDepth) this.error(`Stack overflow (more than ${this.maxDepth} nested calls)`, pos);
    const env = new Environment(fn.closure);
    const params = fn.decl.params;
    for (let i = 0; i < params.length; i++) env.define(params[i], args[i]);

    // The body runs inline here instead of via execBlock(), for the same stack-depth reason.
    const previous = this.env;
    this.env = env;
    this.depth++;
    try {
      const body = fn.decl.body;
      this.hoist(body, env);
      for (let i = 0; i < body.length; i++) {
        if (this.exec(body[i]) === Completion.Return) {
          const result = this.returnValue;
          this.returnValue = null;
          return result;
        }
      }
      return null;
    } catch (e) {
      // The host stack can run out before maxDepth. Do no real work here (the
      // stack is nearly full); conversion succeeds a few frames further up.
      if (e instanceof RangeError) this.error("Stack overflow (too much recursion)", pos);
      throw e;
    } finally {
      this.env = previous;
      this.depth--;
    }
  }

  // ---------- operators ----------

  private binary(op: BinaryOp, a: Value, b: Value, pos: Position): Value {
    switch (op) {
      case "==": return equals(a, b);
      case "!=": return !equals(a, b);
      case "<": case "<=": case ">": case ">=": {
        if (!((typeof a === "number" && typeof b === "number") || (typeof a === "string" && typeof b === "string"))) {
          this.error(`Cannot compare ${typeOf(a)} and ${typeOf(b)} with '${op}'`, pos);
        }
        if (op === "<") return a < b;
        if (op === "<=") return a <= b;
        if (op === ">") return a > b;
        return a >= b;
      }
      case "in":
        if (Array.isArray(b)) return b.some((x) => equals(x, a));
        if (b instanceof Map) return isKey(a) && b.has(a);
        if (typeof b === "string") {
          if (typeof a !== "string") this.error(`Left side of 'in' must be a string when searching a string`, pos);
          return b.includes(a);
        }
        return this.error(`Cannot use 'in' with a ${typeOf(b)}`, pos);
      default:
        return this.arith(op, a, b, pos);
    }
  }

  private arith(op: "+" | "-" | "*" | "/" | "%" | "**", a: Value, b: Value, pos: Position): Value {
    if (op === "+") {
      if (typeof a === "number" && typeof b === "number") return a + b;
      if (typeof a === "string" && typeof b === "string") return a + b;
      if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
      const hint = typeof a === "string" || typeof b === "string" ? " (use str() or a `template ${string}`)" : "";
      this.error(`Cannot add ${typeOf(a)} and ${typeOf(b)}${hint}`, pos);
    }
    if (op === "*" && typeof a === "string" && typeof b === "number") {
      if (!Number.isInteger(b) || b < 0) this.error("String repeat count must be a non-negative integer", pos);
      return a.repeat(b);
    }
    if (typeof a !== "number" || typeof b !== "number") {
      this.error(`Operator '${op}' needs numbers, got ${typeOf(a)} and ${typeOf(b)}`, pos);
    }
    switch (op) {
      case "-": return a - b;
      case "*": return a * b;
      case "**": return a ** b;
      case "/":
        if (b === 0) this.error("Division by zero", pos);
        return a / b;
      case "%":
        if (b === 0) this.error("Division by zero", pos);
        return ((a % b) + b) % b; // mathematical modulo: -1 % 3 == 2
    }
  }

  private listIndex(list: Value[] | string, key: Value, pos: Position): number {
    if (typeof key !== "number" || !Number.isInteger(key)) this.error(`Index must be an integer, got ${typeOf(key)}`, pos);
    const i = key < 0 ? list.length + key : key;
    if (i < 0 || i >= list.length) this.error(`Index ${key} out of range for length ${list.length}`, pos);
    return i;
  }

  private index(object: Value, key: Value, pos: Position): Value {
    if (Array.isArray(object)) return object[this.listIndex(object, key, pos)];
    if (typeof object === "string") return object[this.listIndex(object, key, pos)];
    if (object instanceof Map) return isKey(key) ? object.get(key) ?? null : null;
    return this.error(`Cannot index into a ${typeOf(object)}`, pos);
  }
}

function compoundOp(op: AssignOp): "+" | "-" | "*" | "/" {
  return op[0] as "+" | "-" | "*" | "/";
}
