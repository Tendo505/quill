// The standard library. Every builtin validates its arguments and reports
// errors at the call site, so mistakes read like any other Quill error.

import { QuillError, type Position } from "./errors.js";
import {
  Builtin, Environment, type Interp, type Key, type Value,
  equals, isKey, isTruthy, stringify, typeOf,
} from "./values.js";

const MAX_RANGE = 10_000_000;

function fail(message: string, pos: Position): never {
  throw new QuillError("RuntimeError", message, pos);
}

function expect<T extends Value>(fnName: string, v: Value, type: string, pos: Position, n = 1): T {
  const actual = typeOf(v);
  const ok = type === "callable" ? actual === "function" : actual === type;
  if (!ok) fail(`${fnName}() expects argument ${n} to be a ${type === "callable" ? "function" : type}, got ${actual}`, pos);
  return v as T;
}

function int(fnName: string, v: Value, pos: Position, n = 1): number {
  const x = expect<number>(fnName, v, "number", pos, n);
  if (!Number.isInteger(x)) fail(`${fnName}() expects argument ${n} to be an integer, got ${stringify(x)}`, pos);
  return x;
}

/** Default ordering for sort(): numbers numerically, strings lexically, no mixing. */
function compare(a: Value, b: Value, pos: Position): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  return fail(`sort() cannot compare ${typeOf(a)} and ${typeOf(b)}; pass a comparison function`, pos);
}

type Impl = (interp: Interp, args: Value[], pos: Position) => Value;

export function createGlobals(print: (line: string) => void): Environment {
  const env = new Environment();
  const def = (name: string, arity: [number, number], fn: Impl) => env.define(name, new Builtin(name, arity, fn), true);
  const V = Infinity;

  // ---------- core ----------
  def("print", [0, V], (_, args) => {
    print(args.map((a) => stringify(a)).join(" "));
    return null;
  });
  def("type", [1, 1], (_, [v]) => typeOf(v));
  def("str", [1, 1], (_, [v]) => stringify(v));
  def("repr", [1, 1], (_, [v]) => stringify(v, true));
  def("num", [1, 1], (_, [v], pos) => {
    if (typeof v === "number") return v;
    const s = expect<string>("num", v, "string", pos).trim();
    const n = Number(s.replace(/_/g, ""));
    if (s === "" || Number.isNaN(n)) fail(`num() cannot convert "${s}" to a number`, pos);
    return n;
  });
  def("assert", [1, 2], (_, [cond, msg], pos) => {
    if (!isTruthy(cond)) fail(`Assertion failed${msg != null ? `: ${stringify(msg)}` : ""}`, pos);
    return null;
  });
  def("clock", [0, 0], () => performance.now());

  // ---------- collections ----------
  def("len", [1, 1], (_, [v], pos) => {
    if (typeof v === "string") return [...v].length;
    if (Array.isArray(v)) return v.length;
    if (v instanceof Map) return v.size;
    return fail(`len() expects a string, list or map, got ${typeOf(v)}`, pos);
  });
  def("push", [2, V], (_, [list, ...items], pos) => {
    expect<Value[]>("push", list, "list", pos).push(...items);
    return list;
  });
  def("pop", [1, 1], (_, [list], pos) => {
    const l = expect<Value[]>("pop", list, "list", pos);
    if (l.length === 0) fail("pop() from an empty list", pos);
    return l.pop()!;
  });
  def("insert", [3, 3], (_, [list, i, v], pos) => {
    const l = expect<Value[]>("insert", list, "list", pos);
    const idx = int("insert", i, pos, 2);
    if (idx < 0 || idx > l.length) fail(`insert() index ${idx} out of range for length ${l.length}`, pos);
    l.splice(idx, 0, v);
    return l;
  });
  def("remove", [2, 2], (_, [coll, key], pos) => {
    if (coll instanceof Map) {
      if (!isKey(key)) return null;
      const v = coll.get(key) ?? null;
      coll.delete(key);
      return v;
    }
    const l = expect<Value[]>("remove", coll, "list", pos);
    const i = int("remove", key, pos, 2);
    const idx = i < 0 ? l.length + i : i;
    if (idx < 0 || idx >= l.length) fail(`remove() index ${i} out of range for length ${l.length}`, pos);
    return l.splice(idx, 1)[0];
  });
  def("keys", [1, 1], (_, [m], pos) => [...expect<Map<Key, Value>>("keys", m, "map", pos).keys()]);
  def("values", [1, 1], (_, [m], pos) => [...expect<Map<Key, Value>>("values", m, "map", pos).values()]);
  def("entries", [1, 1], (_, [m], pos) => [...expect<Map<Key, Value>>("entries", m, "map", pos)].map(([k, v]) => [k, v]));
  def("range", [1, 3], (_, args, pos) => {
    const [start, end, step] = args.length === 1 ? [0, int("range", args[0], pos), 1]
      : [int("range", args[0], pos, 1), int("range", args[1], pos, 2), args[2] === undefined ? 1 : int("range", args[2], pos, 3)];
    if (step === 0) fail("range() step cannot be 0", pos);
    const count = Math.max(0, Math.ceil((end - start) / step));
    if (count > MAX_RANGE) fail(`range() would create ${count.toLocaleString("en-US")} items (max ${MAX_RANGE.toLocaleString("en-US")})`, pos);
    return Array.from({ length: count }, (_, i) => start + i * step);
  });
  def("slice", [2, 3], (_, [v, s, e], pos) => {
    const start = int("slice", s, pos, 2);
    const end = e === undefined || e === null ? undefined : int("slice", e, pos, 3);
    if (typeof v === "string") return [...v].slice(start, end).join("");
    return expect<Value[]>("slice", v, "list", pos).slice(start, end);
  });
  def("reverse", [1, 1], (_, [v], pos) => {
    if (typeof v === "string") return [...v].reverse().join("");
    return [...expect<Value[]>("reverse", v, "list", pos)].reverse();
  });
  def("sort", [1, 2], (interp, [list, cmp], pos) => {
    const copy = [...expect<Value[]>("sort", list, "list", pos)];
    if (cmp === undefined) return copy.sort((a, b) => compare(a, b, pos));
    expect("sort", cmp, "callable", pos, 2);
    return copy.sort((a, b) => {
      const r = interp.call(cmp, [a, b], pos);
      if (typeof r !== "number") fail("sort() comparison function must return a number", pos);
      return r;
    });
  });
  def("index_of", [2, 2], (_, [coll, v], pos) => {
    if (typeof coll === "string") return coll.indexOf(expect<string>("index_of", v, "string", pos, 2));
    return expect<Value[]>("index_of", coll, "list", pos).findIndex((x) => equals(x, v));
  });

  // ---------- higher-order ----------
  def("map", [2, 2], (interp, [list, fn], pos) => {
    expect("map", fn, "callable", pos, 2);
    return expect<Value[]>("map", list, "list", pos).map((x) => interp.call(fn, [x], pos));
  });
  def("filter", [2, 2], (interp, [list, fn], pos) => {
    expect("filter", fn, "callable", pos, 2);
    return expect<Value[]>("filter", list, "list", pos).filter((x) => isTruthy(interp.call(fn, [x], pos)));
  });
  def("reduce", [3, 3], (interp, [list, fn, init], pos) => {
    expect("reduce", fn, "callable", pos, 2);
    return expect<Value[]>("reduce", list, "list", pos).reduce<Value>((acc, x) => interp.call(fn, [acc, x], pos), init);
  });
  def("each", [2, 2], (interp, [list, fn], pos) => {
    expect("each", fn, "callable", pos, 2);
    for (const x of [...expect<Value[]>("each", list, "list", pos)]) interp.call(fn, [x], pos);
    return null;
  });
  def("any", [2, 2], (interp, [list, fn], pos) =>
    expect<Value[]>("any", list, "list", pos).some((x) => isTruthy(interp.call(fn, [x], pos))));
  def("all", [2, 2], (interp, [list, fn], pos) =>
    expect<Value[]>("all", list, "list", pos).every((x) => isTruthy(interp.call(fn, [x], pos))));

  // ---------- strings ----------
  def("join", [1, 2], (_, [list, sep], pos) => {
    const s = sep === undefined ? "" : expect<string>("join", sep, "string", pos, 2);
    return expect<Value[]>("join", list, "list", pos).map((x) => stringify(x)).join(s);
  });
  def("split", [1, 2], (_, [str, sep], pos) => {
    const s = expect<string>("split", str, "string", pos);
    return sep === undefined ? [...s] : s.split(expect<string>("split", sep, "string", pos, 2));
  });
  def("upper", [1, 1], (_, [s], pos) => expect<string>("upper", s, "string", pos).toUpperCase());
  def("lower", [1, 1], (_, [s], pos) => expect<string>("lower", s, "string", pos).toLowerCase());
  def("trim", [1, 1], (_, [s], pos) => expect<string>("trim", s, "string", pos).trim());
  def("replace", [3, 3], (_, [s, from, to], pos) =>
    expect<string>("replace", s, "string", pos).split(expect<string>("replace", from, "string", pos, 2)).join(expect<string>("replace", to, "string", pos, 3)));
  def("starts_with", [2, 2], (_, [s, p], pos) => expect<string>("starts_with", s, "string", pos).startsWith(expect<string>("starts_with", p, "string", pos, 2)));
  def("ends_with", [2, 2], (_, [s, p], pos) => expect<string>("ends_with", s, "string", pos).endsWith(expect<string>("ends_with", p, "string", pos, 2)));
  def("pad_start", [2, 3], (_, [s, n, fill], pos) =>
    stringify(s).padStart(int("pad_start", n, pos, 2), fill === undefined ? " " : expect<string>("pad_start", fill, "string", pos, 3)));
  def("pad_end", [2, 3], (_, [s, n, fill], pos) =>
    stringify(s).padEnd(int("pad_end", n, pos, 2), fill === undefined ? " " : expect<string>("pad_end", fill, "string", pos, 3)));
  def("chr", [1, 1], (_, [n], pos) => String.fromCodePoint(int("chr", n, pos)));
  def("ord", [1, 1], (_, [s], pos) => {
    const str = expect<string>("ord", s, "string", pos);
    if (str.length === 0) fail("ord() of an empty string", pos);
    return str.codePointAt(0)!;
  });

  // ---------- math ----------
  const num1 = (name: string, f: (x: number) => number) =>
    def(name, [1, 1], (_, [x], pos) => f(expect<number>(name, x, "number", pos)));
  num1("abs", Math.abs);
  num1("floor", Math.floor);
  num1("ceil", Math.ceil);
  num1("round", Math.round);
  num1("sqrt", (x) => Math.sqrt(x));
  def("min", [1, V], (_, args, pos) => {
    const xs = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
    if (xs.length === 0) fail("min() of an empty list", pos);
    return Math.min(...xs.map((x, i) => expect<number>("min", x, "number", pos, i + 1)));
  });
  def("max", [1, V], (_, args, pos) => {
    const xs = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
    if (xs.length === 0) fail("max() of an empty list", pos);
    return Math.max(...xs.map((x, i) => expect<number>("max", x, "number", pos, i + 1)));
  });
  def("sum", [1, 1], (_, [list], pos) =>
    expect<Value[]>("sum", list, "list", pos).reduce<number>((a, x, i) => a + expect<number>("sum", x, "number", pos, i + 1), 0));
  def("random", [0, 2], (_, args, pos) => {
    if (args.length === 0) return Math.random();
    const [lo, hi] = args.length === 1 ? [0, int("random", args[0], pos)] : [int("random", args[0], pos), int("random", args[1], pos, 2)];
    return lo + Math.floor(Math.random() * (hi - lo));
  });
  env.define("PI", Math.PI, true);

  return env;
}
