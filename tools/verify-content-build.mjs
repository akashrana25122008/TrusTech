// Post-build gate: dist/js/content.js must be a classic script —
// no top-level import/export tokens and no reference to a runtime chunk.
import { readFileSync, existsSync } from "node:fs";

const path = "dist/js/content.js";
if (!existsSync(path)) {
  console.error("verify-content-build: missing dist/js/content.js");
  process.exit(1);
}

const src = readFileSync(path, "utf8");

const hasImport = /(^|[;\s])import\s*[\{\"\'\`a-zA-Z\*\/]/.test(src);
const hasExport = /(^|[;\s])export\s/.test(src);
const runtimeRef = /runtime-[A-Za-z0-9_-]+\.js/.test(src);
const startsAsModule = /^\s*import\s/m.test(src);
const wrapped = /^\s*\(function\(\)\s*\{/.test(src);

const problems = [];
if (hasImport) problems.push("contains an import statement");
if (hasExport) problems.push("contains an export statement");
if (runtimeRef) problems.push("references a split runtime chunk");
if (startsAsModule) problems.push("starts with a top-level import");
if (!wrapped) problems.push("is not wrapped in an IIFE (would leak globals)");

if (problems.length > 0) {
  console.error(`verify-content-build: FAILED — dist/js/content.js ${problems.join("; ")}`);
  process.exit(1);
}

const bytes = src.length;
console.log(`verify-content-build: OK — content.js is a self-contained classic script (${bytes} bytes)`);