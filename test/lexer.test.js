import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { tokenize, QuillError } from "../dist/index.js";

const types = (src) => tokenize(src).map((t) => t.type);

describe("lexer", () => {
  test("operators use longest match", () => {
    assert.deepEqual(types("a ** b |> f => <= == != += -="), [
      "identifier", "**", "identifier", "|>", "identifier", "=>", "<=", "==", "!=", "+=", "-=", "eof",
    ]);
  });

  test("keywords vs identifiers", () => {
    assert.deepEqual(types("let lettuce fn fns nil"), ["let", "identifier", "fn", "identifier", "nil", "eof"]);
  });

  test("numbers: ints, floats, exponents, underscores", () => {
    const values = tokenize("42 3.14 1e3 2.5E-2 1_000_000").filter((t) => t.type === "number").map((t) => t.value);
    assert.deepEqual(values, [42, 3.14, 1000, 0.025, 1000000]);
  });

  test("a trailing dot is not part of a number", () => {
    assert.deepEqual(types("xs.0"), ["identifier", ".", "number", "eof"]);
  });

  test("string escapes and unicode", () => {
    const [tok] = tokenize(String.raw`"tab\tnl\nq\"uni\u{1F600}"`);
    assert.equal(tok.value, 'tab\tnl\nq"uni😀');
  });

  test("comments are skipped and positions are tracked", () => {
    const toks = tokenize("// line\n/* block\n comment */ x");
    assert.equal(toks[0].lexeme, "x");
    assert.deepEqual(toks[0].pos, { line: 3, col: 13 });
  });

  test("template strings split into strings and holes", () => {
    const [tok] = tokenize("`a ${x + 1} b ${ {k: 1}.k } c`");
    assert.deepEqual(tok.value.strings, ["a ", " b ", " c"]);
    assert.deepEqual(tok.value.holes.map((h) => h.source.trim()), ["x + 1", "{k: 1}.k"]);
  });

  test("helpful errors for common mistakes", () => {
    const err = (src) => assert.throws(() => tokenize(src), QuillError);
    err('"unterminated');
    err("/* never closed");
    err("a && b");
    err("12abc");
    err('"bad \\q escape"');
    assert.throws(() => tokenize("a && b"), /Use 'and' instead of '&&'/);
  });
});
