import assert from "node:assert/strict";
import { run } from "../dist/index.js";

/** Run source and return printed lines; fails the test on any error. */
export function output(source, options = {}) {
  const lines = [];
  const result = run(source, { print: (l) => lines.push(l), ...options });
  if (!result.ok) assert.fail(`unexpected error:\n${result.message}`);
  return lines.join("\n");
}

/** Evaluate a single expression and return its printed form. */
export function value(expr) {
  return output(`print(repr(${expr}));`);
}

/** Run source expecting an error; returns the QuillError. */
export function failure(source, options = {}) {
  const result = run(source, { print: () => {}, ...options });
  if (result.ok) assert.fail(`expected an error from:\n${source}`);
  return result.error;
}
