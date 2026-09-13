import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = resolve(ROOT, "dist");
const OUT = resolve(ROOT, "tests/performance/results-bundles.json");

function pick(dir, prefix, ext = ".js") {
  const files = readdirSync(resolve(DIST, dir)).filter((f) => f.startsWith(prefix) && f.endsWith(ext));
  if (files.length !== 1) throw new Error(`expected 1 ${prefix}* in dist/${dir}, found ${files.length}`);
  return `${dir}/${files[0]}`;
}

function measure(rel) {
  const buf = readFileSync(resolve(DIST, rel));
  return { file: rel, bytes: buf.length, gzip: gzipSync(buf).length };
}

function hygiene(rel, patterns) {
  const text = readFileSync(resolve(DIST, rel), "utf-8");
  return Object.fromEntries(patterns.map((p) => [p, text.includes(p)]));
}

const budget = JSON.parse(readFileSync(resolve(ROOT, "performance-budget.json"), "utf-8"));
const panel = pick("js", "panel");
const robot = pick("js", "RobotStage");
const rows = [
  measure(panel),
  measure(robot),
  measure(pick("js", "background")),
  measure(pick("js", "content")),
  measure(pick("assets", "vision.worker")),
  measure(pick("assets", "transformers.web")),
  measure(pick("assets", "panel", ".css")),
];
const panelName = panel.split("/").pop();
const checks = {
  panelWithinBudget: rows[0].bytes <= budget.panelJsMaxBytes,
  robotWithinBudget: rows[1].bytes <= budget.robotChunkMaxBytes,
  threeInPanel: hygiene(panel, ["WebGLRenderer"]).WebGLRenderer,
  threeInRobotChunk: hygiene(robot, ["WebGLRenderer"]).WebGLRenderer,
  modelRuntimeInPanel: hygiene(panel, ["InferenceSession", "onnxruntime"]).InferenceSession ||
    hygiene(panel, ["InferenceSession", "onnxruntime"]).onnxruntime,
  panelReferencesRobotChunk: new RegExp(robot.split("/").pop().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).test(
    readFileSync(resolve(DIST, panel), "utf-8"),
  ),
};
const pass = checks.panelWithinBudget && checks.robotWithinBudget && !checks.threeInPanel &&
  checks.threeInRobotChunk && !checks.modelRuntimeInPanel && checks.panelReferencesRobotChunk;

const report = {
  generatedAt: new Date().toISOString(),
  budget: "performance-budget.json",
  chunks: rows,
  checks,
  pass,
  panelFile: panelName,
};
writeFileSync(OUT, JSON.stringify(report, null, 2) + "\n");
for (const r of rows) console.log(`${r.file}: ${r.bytes} B (gzip ${r.gzip} B)`);
console.log(pass ? "BUNDLES: PASS" : "BUNDLES: FAIL");
process.exit(pass ? 0 : 1);
