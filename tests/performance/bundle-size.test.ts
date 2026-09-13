// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

const ROOT = process.cwd();
const DIST = resolve(ROOT, "dist");

function find(prefix: string, ext = ".js"): string {
  const files = readdirSync(resolve(DIST, "js")).filter((f) => f.startsWith(prefix) && f.endsWith(ext));
  expect(files.length).toBe(1);
  return resolve(DIST, "js", files[0]);
}

function budget(): Record<string, number> {
  return JSON.parse(readFileSync(resolve(ROOT, "performance-budget.json"), "utf-8"));
}

describe("bundle budgets (Phase 9 regression gates)", () => {
  it("dist chunks stay within performance-budget.json", () => {
    const b = budget();
    const sizes: Record<string, number> = {
      panel: statSync(find("panel")).size,
      background: statSync(find("background")).size,
      content: statSync(find("content")).size,
    };
    const workerFiles = readdirSync(resolve(DIST, "assets")).filter((f) => f.startsWith("vision.worker"));
    expect(workerFiles.length).toBe(1);
    sizes.visionWorker = statSync(resolve(DIST, "assets", workerFiles[0])).size;
    const robotFiles = readdirSync(resolve(DIST, "js")).filter((f) => f.startsWith("RobotStage"));
    expect(robotFiles.length).toBe(1);
    sizes.robot = statSync(resolve(DIST, "js", robotFiles[0])).size;

    console.log(
      `[perf:bundles] panel=${sizes.panel} background=${sizes.background} content=${sizes.content} visionWorker=${sizes.visionWorker} robot=${sizes.robot}`,
    );
    expect(sizes.panel).toBeLessThanOrEqual(b.panelJsMaxBytes);
    expect(sizes.background).toBeLessThanOrEqual(b.backgroundJsMaxBytes);
    expect(sizes.content).toBeLessThanOrEqual(b.contentJsMaxBytes);
    expect(sizes.visionWorker).toBeLessThanOrEqual(b.visionWorkerMaxBytes);
    expect(sizes.robot).toBeLessThanOrEqual(b.robotChunkMaxBytes);
  });

  it("heavy runtimes stay out of the initial panel bundle", () => {
    const panel = readFileSync(find("panel"), "utf-8");
    // three.js must live in the lazy RobotStage chunk, never in initial panel.js
    expect(panel).not.toContain("WebGLRenderer");
    // onnx/transformers model runtime must stay in the vision worker chunk
    expect(panel).not.toMatch(/InferenceSession|onnxruntime|__createDetectionsProcessor/);
    // panel must reference the lazy robot chunk instead of inlining it
    expect(panel).toMatch(/RobotStage-[A-Za-z0-9]+\.js/);

    const robotFile = readdirSync(resolve(DIST, "js")).find((f) => f.startsWith("RobotStage"))!;
    const robot = readFileSync(resolve(DIST, "js", robotFile), "utf-8");
    expect(robot).toContain("WebGLRenderer");
  });
});
