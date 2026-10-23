import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { output, value, failure } from "./helpers.js";

describe("expressions and precedence", () => {
  const cases = [
    ["1 + 2 * 3", "7"],
    ["(1 + 2) * 3", "9"],
    ["2 ** 3 ** 2", "512"],          // right associative
    ["-2 ** 2", "-4"],               // ** binds tighter than unary minus
    ["2 ** -1", "0.5"],
    ["10 - 4 - 3", "3"],             // left associative
    ["-7 % 3", "2"],                 // mathematical modulo
    ["7 / 2", "3.5"],
    ["0.1 + 0.2", "0.3"],            // display rounds float noise
    ["1 < 2 == true", "true"],
    ["not true or true", "true"],
    ["!false and false", "false"],
    ["nil or \"default\"", '"default"'],
    ["0 or 1", "0"],                 // only false and nil are falsy
    ["true ? 1 : 2", "1"],
    ["false ? 1 : true ? 2 : 3", "2"],
    ['"ab" * 3', '"ababab"'],
    ["[1, 2] + [3]", "[1, 2, 3]"],
    ['2 in [1, 2, 3]', "true"],
    ['"ell" in "hello"', "true"],
    ['"k" in {k: 1}', "true"],
    ["[1, 2] == [1, 2]", "false"],   // lists compare by identity
  ];
  for (const [expr, expected] of cases) {
    test(`${expr}  =>  ${expected}`, () => assert.equal(value(expr), expected));
  }
});

describe("variables and scope", () => {
  test("block scoping and shadowing", () => {
    assert.equal(output(`
      let x = "outer";
      { let x = "inner"; print(x); }
      print(x);
    `), "inner\nouter");
  });

  test("compound assignment", () => {
    assert.equal(output("let n = 10; n += 5; n -= 3; n *= 2; n /= 4; print(n);"), "6");
  });

  test("assignment is an expression and right associative", () => {
    assert.equal(output("let a = 0; let b = 0; a = b = 7; print(a, b);"), "7 7");
  });

  test("closures resolve lexically, not dynamically", () => {
    // The classic resolver test: `show` must keep seeing the global `a`.
    assert.equal(output(`
      let a = "global";
      {
        fn show() { print(a); }
        show();
        let a = "block";
        show();
      }
    `), "global\nglobal");
  });

  test("functions are hoisted within their block", () => {
    assert.equal(output(`
      print(is_even(10));
      fn is_even(n) => n == 0 ? true : is_odd(n - 1);
      fn is_odd(n) => n == 0 ? false : is_even(n - 1);
    `), "true");
  });

  test("loop variables are fresh per iteration", () => {
    assert.equal(output("let fs = []; for (i in range(3)) { push(fs, fn() => i); } print(map(fs, fn(f) => f()));"), "[0, 1, 2]");
  });

  test("REPL-style global redefinition is allowed", () => {
    assert.equal(output("let x = 1; let x = 2; print(x);"), "2");
  });
});

describe("functions", () => {
  test("recursion", () => {
    assert.equal(output("fn fact(n) => n <= 1 ? 1 : n * fact(n - 1); print(fact(10));"), "3628800");
  });

  test("closures keep private state", () => {
    assert.equal(output(`
      fn counter() { let n = 0; return fn() { n += 1; return n; }; }
      let a = counter(); let b = counter();
      a(); a();
      print(a(), b());
    `), "3 1");
  });

  test("implicit nil return", () => {
    assert.equal(value("(fn() {})()"), "nil");
  });

  test("pipe operator", () => {
    assert.equal(value("[3, 1, 2] |> sort |> map(fn(x) => x * 10)"), "[10, 20, 30]");
    assert.equal(value("5 |> fn(x) => x + 1"), "6");
  });

  test("arity is checked", () => {
    assert.match(failure("fn f(a, b) {} f(1);").message, /f\(\) expects 2 arguments, got 1/);
    assert.match(failure("len();").message, /len\(\) expects 1 argument, got 0/);
  });
});

describe("control flow", () => {
  test("while with break and continue", () => {
    assert.equal(output(`
      let i = 0; let out = [];
      while (true) {
        i += 1;
        if (i % 2 == 0) { continue; }
        if (i > 7) { break; }
        push(out, i);
      }
      print(out);
    `), "[1, 3, 5, 7]");
  });

  test("for over lists, strings and map keys", () => {
    assert.equal(output(`
      for (x in [1, 2]) { print(x); }
      for (c in "hi") { print(c); }
      for (k in {a: 1, b: 2}) { print(k); }
    `), "1\n2\nh\ni\na\nb");
  });

  test("return from inside nested loops", () => {
    assert.equal(output(`
      fn find(grid, target) {
        for (row in grid) { for (x in row) { if (x == target) { return x * 100; } } }
        return -1;
      }
      print(find([[1, 2], [3, 4]], 3));
    `), "300");
  });

  test("mutating a list while iterating is safe", () => {
    assert.equal(output("let xs = [1, 2]; for (x in xs) { push(xs, x); } print(xs);"), "[1, 2, 1, 2]");
  });

  test("else-if chains", () => {
    assert.equal(output(`
      fn grade(n) { if (n >= 90) { return "A"; } else if (n >= 80) { return "B"; } else { return "C"; } }
      print(grade(95), grade(85), grade(10));
    `), "A B C");
  });
});

describe("collections", () => {
  test("negative indexing and index assignment", () => {
    assert.equal(output("let xs = [1, 2, 3]; xs[-1] = 30; xs[0] += 10; print(xs, xs[-2]);"), "[11, 2, 30] 2");
  });

  test("maps: dot access, computed keys, shorthand, missing keys are nil", () => {
    assert.equal(output(`
      let k = "dyn"; let name = "Ada";
      let m = { a: 1, "with space": 2, [k]: 3, name };
      m.b = m.a + 1;
      print(m, m.missing);
    `), '{ a: 1, "with space": 2, dyn: 3, name: "Ada", b: 2 } nil');
  });

  test("nested structures print with quoted strings", () => {
    assert.equal(value('{ list: [1, "two", nil, true], nested: { x: 1.5 } }'), '{ list: [1, "two", nil, true], nested: { x: 1.5 } }');
  });

  test("cyclic structures print without hanging", () => {
    assert.equal(output("let a = [1]; push(a, a); print(a);"), "[1, [...]]");
  });
});

describe("templates", () => {
  test("interpolate expressions, including nested braces", () => {
    assert.equal(output('let p = {n: 2}; print(`n=${p.n}, sq=${p.n ** 2}, m=${ {k: "v"}.k }`);'), "n=2, sq=4, m=v");
  });

  test("errors inside a hole point at the right column", () => {
    const err = failure('let x = 1;\nprint(`value: ${x + "a"}`);');
    assert.deepEqual(err.pos, { line: 2, col: 19 });
  });
});

describe("errors", () => {
  test("try/catch receives runtime error details", () => {
    assert.equal(output('try { [1][5]; } catch (e) { print(e.message, e.line); }'), "Index 5 out of range for length 1 1");
  });

  test("throw any value; catch rebinds scope correctly", () => {
    assert.equal(output(`
      fn risky() { throw { code: 7 }; }
      let depth = "outer";
      try { fn inner() { let depth = "inner"; risky(); } inner(); }
      catch (e) { print(e.code, depth); }
    `), "7 outer");
  });

  test("uncaught throw reports the value", () => {
    assert.match(failure('throw "boom";').message, /Uncaught "boom"/);
  });

  test("static scope errors", () => {
    const cases = [
      ["return 1;", /'return' outside of a function/],
      ["break;", /'break' outside of a loop/],
      ["fn f() { while (true) { fn g() { break; } } }", /'break' outside of a loop/],
      ["const c = 1; c = 2;", /Cannot assign to const 'c'/],
      ["fn f() { let a = 1; let a = 2; }", /already declared in this scope/],
      ["fn f() { let a = a; }", /Cannot read 'a' in its own initializer/],
    ];
    for (const [src, re] of cases) {
      const err = failure(src);
      assert.equal(err.kind, "ScopeError", src);
      assert.match(err.message, re);
    }
  });

  test("type errors carry precise positions", () => {
    const err = failure('let total = 5;\nprint("Total: " + total);');
    assert.equal(err.kind, "RuntimeError");
    assert.match(err.message, /Cannot add string and number/);
    assert.deepEqual(err.pos, { line: 2, col: 17 });
  });

  test("syntax errors name what was found", () => {
    assert.match(failure("let = 5;").message, /Expected variable name after 'let' \(found '='\)/);
    assert.match(failure("print(1").message, /found end of input/);
    assert.match(failure("1 + 2 = 3;").message, /Invalid assignment target/);
  });

  test("division by zero and bad indexing", () => {
    assert.match(failure("1 / 0;").message, /Division by zero/);
    assert.match(failure('[1, 2]["x"];').message, /Index must be an integer/);
    assert.match(failure("nil();").message, /Cannot call a nil/);
  });
});

describe("safety limits", () => {
  test("infinite loops hit the step budget", () => {
    assert.match(failure("while (true) {}", { maxSteps: 10_000 }).message, /Execution limit exceeded/);
  });

  test("the step budget cannot be caught by try/catch", () => {
    assert.match(failure("try { while (true) {} } catch (e) { print(e); }", { maxSteps: 10_000 }).message, /Execution limit/);
  });

  test("runaway recursion reports a stack overflow instead of crashing", () => {
    assert.match(failure("fn f() => f(); f();").message, /Stack overflow/);
  });

  test("moderate recursion depth works", () => {
    assert.equal(output("fn down(n) => n == 0 ? 0 : 1 + down(n - 1); print(down(400));"), "400");
  });
});
