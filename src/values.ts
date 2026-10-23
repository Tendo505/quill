import type { FunctionExpr } from "./ast.js";
import type { Position } from "./errors.js";

export type Key = string | number | boolean | null;

export type Value =
  | number
  | string
  | boolean
  | null
  | Value[]
  | Map<Key, Value>
  | Callable;

export interface Interp {
  call(callee: Value, args: Value[], pos: Position): Value;
}

export abstract class Callable {
  abstract readonly name: string;
  abstract call(interp: Interp, args: Value[], pos: Position): Value;
  /** [min, max] argument count; max Infinity for variadic. */
  abstract arity(): [number, number];
}

/** Lexical environment. Variables are found by resolved depth, never by searching. */
export class Environment {
  readonly vars = new Map<string, Value>();
  /** Allocated lazily: most scopes never declare a const, and scopes are created per call. */
  private consts: Set<string> | null = null;

  constructor(readonly parent: Environment | null = null) {}

  define(name: string, value: Value, isConst = false): void {
    this.vars.set(name, value);
    if (isConst) (this.consts ??= new Set()).add(name);
  }

  isConst(name: string): boolean {
    return this.consts !== null && this.consts.has(name);
  }

  ancestor(depth: number): Environment {
    let env: Environment = this;
    for (let i = 0; i < depth; i++) env = env.parent!;
    return env;
  }
}

export class QuillFunction extends Callable {
  constructor(
    readonly decl: FunctionExpr,
    readonly closure: Environment,
    private readonly invoke: (fn: QuillFunction, args: Value[], pos: Position) => Value,
  ) {
    super();
  }

  get name(): string {
    return this.decl.name ?? "anonymous";
  }

  arity(): [number, number] {
    return [this.decl.params.length, this.decl.params.length];
  }

  call(_interp: Interp, args: Value[], pos: Position): Value {
    return this.invoke(this, args, pos);
  }
}

export class Builtin extends Callable {
  constructor(
    readonly name: string,
    private readonly range: [number, number],
    readonly fn: (interp: Interp, args: Value[], pos: Position) => Value,
  ) {
    super();
  }

  arity(): [number, number] {
    return this.range;
  }

  call(interp: Interp, args: Value[], pos: Position): Value {
    return this.fn(interp, args, pos);
  }
}

// ---------- helpers ----------

export function typeOf(v: Value): string {
  if (v === null) return "nil";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "number") return "number";
  if (typeof v === "string") return "string";
  if (Array.isArray(v)) return "list";
  if (v instanceof Map) return "map";
  return "function";
}

export function isTruthy(v: Value): boolean {
  return v !== null && v !== false;
}

export function isKey(v: Value): v is Key {
  return v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

export function equals(a: Value, b: Value): boolean {
  return a === b || (typeof a === "number" && typeof b === "number" && Number.isNaN(a) && Number.isNaN(b));
}

function formatNumber(n: number): string {
  if (Number.isInteger(n) && Math.abs(n) < 1e21) return String(n);
  if (Number.isNaN(n)) return "nan";
  if (!Number.isFinite(n)) return n > 0 ? "inf" : "-inf";
  return String(Number(n.toPrecision(15)));
}

/** Display form. Strings are bare at the top level and quoted inside collections. */
export function stringify(v: Value, nested = false, seen = new Set<Value>()): string {
  if (v === null) return "nil";
  if (typeof v === "number") return formatNumber(v);
  if (typeof v === "string") return nested ? JSON.stringify(v) : v;
  if (typeof v === "boolean") return String(v);
  if (seen.has(v)) return Array.isArray(v) ? "[...]" : "{...}";
  if (Array.isArray(v)) {
    seen.add(v);
    const out = `[${v.map((x) => stringify(x, true, seen)).join(", ")}]`;
    seen.delete(v);
    return out;
  }
  if (v instanceof Map) {
    seen.add(v);
    const parts = [...v].map(([k, val]) => {
      const key = typeof k === "string" && /^[A-Za-z_]\w*$/.test(k) ? k : stringify(k, true, seen);
      return `${key}: ${stringify(val, true, seen)}`;
    });
    seen.delete(v);
    return parts.length ? `{ ${parts.join(", ")} }` : "{}";
  }
  return v instanceof Builtin ? `<builtin ${v.name}>` : `<fn ${v.name}>`;
}
