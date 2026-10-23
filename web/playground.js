import { tokenize } from "./quill/index.js";
import examples from "./examples.js";

const $ = (id) => document.getElementById(id);
const source = $("source");
const highlight = $("highlight");
const gutter = $("gutter");
const output = $("output");
const status = $("status");
const runButton = $("run");
const exampleSelect = $("examples");

const TIMEOUT_MS = 8000;
const STORAGE_KEY = "quill:playground:code";

// ---------- syntax highlighting (reuses the real lexer) ----------

const KEYWORD = new Set(["let", "const", "fn", "return", "if", "else", "while", "for", "in", "break", "continue", "and", "or", "not", "try", "catch", "throw"]);
const LITERAL = new Set(["true", "false", "nil"]);

const escapeHtml = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
const span = (cls, text) => `<span class="t-${cls}">${escapeHtml(text)}</span>`;

/** Whitespace and comments live in the gaps between tokens. */
function renderGap(text) {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(/\/\/[^\n]*|\/\*[\s\S]*?(\*\/|$)/g)) {
    out += escapeHtml(text.slice(last, m.index)) + span("comment", m[0]);
    last = m.index + m[0].length;
  }
  return out + escapeHtml(text.slice(last));
}

function renderHighlight(code) {
  let tokens;
  try {
    tokens = tokenize(code);
  } catch {
    // Mid-edit code often doesn't lex (e.g. an unclosed string); highlight what we can.
    const cut = findLexablePrefix(code);
    return renderTokens(code.slice(0, cut), tokenize(code.slice(0, cut))) + renderGap(code.slice(cut));
  }
  return renderTokens(code, tokens);
}

function findLexablePrefix(code) {
  let lo = 0;
  let hi = code.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    try { tokenize(code.slice(0, mid)); lo = mid; } catch { hi = mid - 1; }
  }
  return lo;
}

function renderTokens(code, tokens) {
  let html = "";
  let pos = 0;
  tokens.forEach((tok, i) => {
    if (tok.type === "eof") return;
    html += renderGap(code.slice(pos, tok.start));
    const text = code.slice(tok.start, tok.end);
    let cls = null;
    if (KEYWORD.has(tok.type)) cls = "keyword";
    else if (LITERAL.has(tok.type)) cls = "literal";
    else if (tok.type === "number") cls = "number";
    else if (tok.type === "string" || tok.type === "template") cls = "string";
    else if (tok.type === "identifier" && tokens[i + 1]?.type === "(") cls = "call";
    else if (tok.type !== "identifier" && !"()[]{},;.".includes(tok.type)) cls = "op";
    html += cls ? span(cls, text) : escapeHtml(text);
    pos = tok.end;
  });
  return html + renderGap(code.slice(pos));
}

// ---------- editor ----------

let errorLine = null;

function refresh() {
  const code = source.value;
  highlight.innerHTML = renderHighlight(code) + "\n";
  const lines = code.split("\n").length;
  let g = "";
  for (let i = 1; i <= lines; i++) g += i === errorLine ? `<div class="err">${i}</div>` : `<div>${i}</div>`;
  gutter.innerHTML = g;
  syncScroll();
}

function syncScroll() {
  highlight.scrollTop = source.scrollTop;
  highlight.scrollLeft = source.scrollLeft;
  gutter.scrollTop = source.scrollTop;
}

/** Insert text at the cursor, keeping the browser's undo history where supported. */
function insert(text) {
  if (!document.execCommand("insertText", false, text)) {
    source.setRangeText(text, source.selectionStart, source.selectionEnd, "end");
    refresh();
  }
}

source.addEventListener("input", () => {
  errorLine = null;
  refresh();
  save();
});
source.addEventListener("scroll", syncScroll);

source.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    e.preventDefault();
    runCode();
  } else if (e.key === "Tab" && !e.shiftKey && !e.ctrlKey) {
    e.preventDefault();
    insert("  ");
  } else if (e.key === "Enter" && !e.shiftKey) {
    // Keep the current indentation, and indent one level after an opening brace.
    const before = source.value.slice(0, source.selectionStart);
    const line = before.slice(before.lastIndexOf("\n") + 1);
    const indent = line.match(/^\s*/)[0] + (/[{[(]\s*$/.test(line) ? "  " : "");
    e.preventDefault();
    insert("\n" + indent);
  } else if (e.key === "}" ) {
    // Dedent a closing brace typed on an otherwise blank line.
    const before = source.value.slice(0, source.selectionStart);
    const line = before.slice(before.lastIndexOf("\n") + 1);
    if (/^\s{2,}$/.test(line) && source.selectionStart === source.selectionEnd) {
      e.preventDefault();
      source.setSelectionRange(source.selectionStart - 2, source.selectionStart);
      insert("}");
    }
  }
});

// ---------- persistence & sharing ----------

let saveTimer;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(STORAGE_KEY, source.value); } catch { /* storage unavailable */ }
  }, 300);
}

const toBase64Url = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromBase64Url = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));

$("share").addEventListener("click", async () => {
  const url = `${location.origin}${location.pathname}#code=${toBase64Url(source.value)}`;
  history.replaceState(null, "", url);
  const button = $("share");
  try {
    await navigator.clipboard.writeText(url);
    button.textContent = "Link copied";
  } catch {
    button.textContent = "Link in address bar";
  }
  setTimeout(() => (button.textContent = "Share"), 1800);
});

function initialCode() {
  const hash = new URLSearchParams(location.hash.slice(1)).get("code");
  if (hash) {
    try { return fromBase64Url(hash); } catch { /* fall through */ }
  }
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return saved;
  } catch { /* storage unavailable */ }
  return examples[0].code;
}

// ---------- examples ----------

exampleSelect.innerHTML = `<option value="" disabled selected>Examples…</option>` +
  examples.map((ex, i) => `<option value="${i}">${escapeHtml(ex.name)}</option>`).join("");

exampleSelect.addEventListener("change", () => {
  const ex = examples[Number(exampleSelect.value)];
  source.value = ex.code;
  source.scrollTop = 0;
  errorLine = null;
  refresh();
  save();
  exampleSelect.selectedIndex = 0;
  runCode();
});

// ---------- running ----------

let worker = null;
let timer = null;

function append(text, cls) {
  if (cls) {
    const el = document.createElement("span");
    el.className = cls;
    el.textContent = text;
    output.append(el);
  } else {
    output.append(text + "\n");
  }
}

function finish(state, label) {
  clearTimeout(timer);
  runButton.disabled = false;
  runButton.textContent = "▶ Run";
  status.className = `status ${state}`;
  status.textContent = label;
}

function runCode() {
  worker?.terminate();
  worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  output.textContent = "";
  errorLine = null;
  refresh();
  runButton.disabled = true;
  runButton.textContent = "Running…";
  status.className = "status";
  status.textContent = "running…";

  worker.onmessage = ({ data }) => {
    if (data.type === "print") {
      append(data.lines.join("\n"));
      return;
    }
    if (data.truncated) append("(output truncated after 5,000 lines)", "note");
    if (data.ok) {
      if (!output.textContent) append("(no output; use print() to show values)", "note");
      finish("ok", `✓ ${data.ms.toFixed(1)} ms`);
    } else {
      append(data.error.message, "error");
      errorLine = data.error.line;
      refresh();
      finish("fail", "✗ error");
    }
    output.scrollTop = output.scrollHeight;
  };

  worker.onerror = (e) => {
    append(`Internal error: ${e.message}`, "error");
    finish("fail", "✗ crashed");
  };

  timer = setTimeout(() => {
    worker.terminate();
    worker = null;
    append(`Stopped after ${TIMEOUT_MS / 1000}s. Is there an infinite loop?`, "error");
    finish("fail", "✗ timeout");
  }, TIMEOUT_MS);

  worker.postMessage({ code: source.value });
}

runButton.addEventListener("click", runCode);

source.value = initialCode();
refresh();
runCode();
