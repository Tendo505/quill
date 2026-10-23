#!/usr/bin/env node
// quill <file.qn>   run a script
// quill             start the interactive REPL
// quill -e "code"   evaluate a snippet

import fs from "node:fs";
import readline from "node:readline";
import { Session, run, stringify } from "../dist/index.js";

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const red = (s) => (color ? `\x1b[31m${s}\x1b[0m` : s);
const dim = (s) => (color ? `\x1b[2m${s}\x1b[0m` : s);
const cyan = (s) => (color ? `\x1b[36m${s}\x1b[0m` : s);

const args = process.argv.slice(2);

if (args[0] === "-h" || args[0] === "--help") {
  console.log("Usage: quill [file.qn] | quill -e <code>\nWith no arguments, starts an interactive REPL.");
  process.exit(0);
}

if (args[0] === "-e") {
  const result = run(args.slice(1).join(" "));
  if (!result.ok) {
    console.error(red(result.message));
    process.exit(1);
  }
  process.exit(0);
}

if (args[0]) {
  let source;
  try {
    source = fs.readFileSync(args[0], "utf8");
  } catch {
    console.error(red(`quill: cannot read file '${args[0]}'`));
    process.exit(66);
  }
  const result = run(source);
  if (!result.ok) {
    console.error(red(result.message.replace(/^(\s*-->)/m, `$1 ${args[0]},`)));
    process.exit(1);
  }
  process.exit(0);
}

// ---------- REPL ----------

const session = new Session();
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: cyan("quill> "),
});

console.log(`Quill REPL. ${dim("Multi-line input continues until brackets balance. Ctrl+D to exit.")}`);
rl.prompt();

let buffer = "";

rl.on("line", (line) => {
  buffer += (buffer ? "\n" : "") + line;
  if (!isComplete(buffer)) {
    rl.setPrompt(dim("  ...  "));
    rl.prompt();
    return;
  }
  const source = buffer;
  buffer = "";
  rl.setPrompt(cyan("quill> "));

  if (source.trim()) {
    const result = session.run(source);
    if (!result.ok) console.log(red(result.message));
    else if (result.value !== undefined && result.value !== null) console.log(dim("=> ") + stringify(result.value, true));
  }
  rl.prompt();
});

rl.on("close", () => {
  console.log();
  process.exit(0);
});

/** Wait for more input while (), [], {} or a string are still open. */
function isComplete(src) {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
    } else if (ch === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
    } else if ("([{".includes(ch)) {
      depth++;
    } else if (")]}".includes(ch)) {
      depth--;
    }
  }
  return depth <= 0 && (quote === null || quote !== "`");
}
