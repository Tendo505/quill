// Assemble the static playground into _site/:
//   web/*            → _site/
//   dist/*.js        → _site/quill/      (the compiled interpreter)
//   examples/*.qn    → _site/examples.js (generated module)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "_site");

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, "quill"), { recursive: true });

for (const f of fs.readdirSync(path.join(root, "web"))) {
  fs.copyFileSync(path.join(root, "web", f), path.join(out, f));
}
for (const f of fs.readdirSync(path.join(root, "dist")).filter((f) => f.endsWith(".js"))) {
  // Drop the sourceMappingURL comment: the .map files aren't deployed.
  const js = fs.readFileSync(path.join(root, "dist", f), "utf8").replace(/\n\/\/# sourceMappingURL=.*$/, "\n");
  fs.writeFileSync(path.join(out, "quill", f), js);
}

const title = (file) => {
  const words = file.replace(/^\d+-/, "").replace(/\.qn$/, "").replace(/-/g, " ");
  return words[0].toUpperCase() + words.slice(1);
};
const examples = fs.readdirSync(path.join(root, "examples"))
  .filter((f) => f.endsWith(".qn"))
  .sort()
  .map((f) => ({ name: title(f), code: fs.readFileSync(path.join(root, "examples", f), "utf8").replace(/\r\n/g, "\n") }));
fs.writeFileSync(path.join(out, "examples.js"), `export default ${JSON.stringify(examples, null, 2)};\n`);

console.log(`built _site/ with ${examples.length} examples`);
