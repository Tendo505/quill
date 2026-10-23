// Runs Quill code off the main thread. The page can terminate this worker
// at any time, so even a runaway program never freezes the UI.

import { run } from "./quill/index.js";

const MAX_OUTPUT_LINES = 5000;

self.onmessage = ({ data: { code } }) => {
  let lines = [];
  let total = 0;
  let truncated = false;

  // Stream output in small batches so long-running programs show progress.
  let lastFlush = performance.now();
  const flush = () => {
    if (lines.length) self.postMessage({ type: "print", lines });
    lines = [];
    lastFlush = performance.now();
  };

  const start = performance.now();
  const result = run(code, {
    maxSteps: 50_000_000,
    print(line) {
      if (++total > MAX_OUTPUT_LINES) {
        truncated = true;
        return;
      }
      lines.push(line);
      if (performance.now() - lastFlush > 50) flush();
    },
  });
  flush();

  self.postMessage({
    type: "done",
    ok: result.ok,
    error: result.ok ? null : { message: result.message, line: result.error.pos.line },
    truncated,
    ms: performance.now() - start,
  });
};
