import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Session, formatError, run } from "../dist/index.js";
import { value, failure, output } from "./helpers.js";

describe("standard library", () => {
  const cases = [
    ["len(\"héllo\")", "5"],
    ["len({a: 1})", "1"],
    ["range(5)", "[0, 1, 2, 3, 4]"],
    ["range(10, 0, -3)", "[10, 7, 4, 1]"],
    ["slice([1, 2, 3, 4], 1, 3)", "[2, 3]"],
    ["slice(\"hello\", -3)", '"llo"'],
    ["reverse(\"abc\")", '"cba"'],
    ["sort([3, 1, 2])", "[1, 2, 3]"],
    ["sort([\"b\", \"a\"])", '["a", "b"]'],
    ["sort([1, 2, 3], fn(a, b) => b - a)", "[3, 2, 1]"],
    ["reduce([1, 2, 3], fn(acc, x) => acc + x, 10)", "16"],
    ["any([1, 2], fn(x) => x > 1)", "true"],
    ["all([1, 2], fn(x) => x > 1)", "false"],
    ["join([1, \"a\", nil], \"-\")", '"1-a-nil"'],
    ["split(\"a,b,,c\", \",\")", '["a", "b", "", "c"]'],
    ["split(\"hi\")", '["h", "i"]'],
    ["upper(\"abc\")", '"ABC"'],
    ["replace(\"a.b.c\", \".\", \"/\")", '"a/b/c"'],
    ["pad_start(\"7\", 3, \"0\")", '"007"'],
    ["index_of([5, 6, 7], 7)", "2"],
    ["num(\" 1_000 \")", "1000"],
    ["str([1, \"x\"])", '"[1, \\"x\\"]"'],
    ["type(fn() => 1)", '"function"'],
    ["type(print)", '"function"'],
    ["max([3, 9, 2])", "9"],
    ["min(4, 2, 8)", "2"],
    ["sum([])", "0"],
    ["floor(-1.5)", "-2"],
    ["ord(\"A\") + 1 |> chr", '"B"'],
    ["keys({x: 1, y: 2})", '["x", "y"]'],
    ["entries({x: 1})", '[["x", 1]]'],
  ];
  for (const [expr, expected] of cases) {
    test(`${expr}  =>  ${expected}`, () => assert.equal(value(expr), expected));
  }

  test("collection mutators", () => {
    assert.equal(output(`
      let xs = [1, 2, 3];
      push(xs, 4, 5);
      print(pop(xs), remove(xs, 0), insert(xs, 1, 99));
      let m = {a: 1, b: 2};
      print(remove(m, "a"), m);
    `), "5 1 [2, 99, 3, 4]\n1 { b: 2 }");
  });

  test("builtins validate argument types", () => {
    assert.match(failure("len(5);").message, /len\(\) expects a string, list or map, got number/);
    assert.match(failure("map([1], 5);").message, /expects argument 2 to be a function/);
    assert.match(failure('num("abc");').message, /cannot convert "abc"/);
    assert.match(failure("pop([]);").message, /empty list/);
    assert.match(failure('sort([1, "a"]);').message, /cannot compare (number and string|string and number)/);
    assert.match(failure("range(0, 10, 0);").message, /step cannot be 0/);
    assert.match(failure("range(100000000);").message, /would create/);
    assert.match(failure("assert(1 == 2, \"math\");").message, /Assertion failed: math/);
  });

  test("builtins cannot be reassigned", () => {
    assert.match(failure("print = 5;").message, /Cannot assign to const 'print'/);
  });
});

describe("Session (REPL)", () => {
  test("keeps globals between runs and returns the last expression value", () => {
    const s = new Session({ print: () => {} });
    assert.ok(s.run("let x = 20;").ok);
    const r = s.run("x * 2 + 2");
    assert.ok(r.ok);
    assert.equal(r.value, 42);
  });

  test("a failed line doesn't corrupt the session", () => {
    const s = new Session({ print: () => {} });
    s.run("const k = 1;");
    assert.equal(s.run("k = 2;").ok, false);
    assert.equal(s.run("let y = ;").ok, false);
    assert.equal(s.run("k + 1").value, 2);
  });
});

describe("formatError", () => {
  test("renders a caret under the error column", () => {
    const src = 'let a = 1;\nlet b = a + "x";';
    const r = run(src, { print: () => {} });
    assert.equal(formatError(src, r.error), [
      "RuntimeError: Cannot add number and string (use str() or a `template ${string}`)",
      " --> line 2, col 11",
      "  |",
      '2 | let b = a + "x";',
      "  |           ^",
    ].join("\n"));
  });
});

describe("examples (golden output)", () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "examples");
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".qn"))) {
    test(file, () => {
      const src = fs.readFileSync(path.join(dir, file), "utf8");
      const expected = fs.readFileSync(path.join(dir, file.replace(/\.qn$/, ".out")), "utf8");
      assert.equal(output(src) + "\n", expected.replace(/\r\n/g, "\n"));
    });
  }
});
