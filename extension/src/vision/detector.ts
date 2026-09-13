import { VISION_ID2LABEL } from "./labels";
import { labelToType } from "./model";
import type { VisionBBox, VisionDetection } from "./types";

export interface DetectorInputs {
  logits: Float32Array;
  predBoxes: Float32Array;
  numQueries: number;
  numClasses: number;
  width: number;
  height: number;
  threshold: number;
  maxDetections: number;
  nmsIouThreshold?: number;
}

export function softmaxRow(logits: Float32Array, offset: number, numClasses: number): Float32Array {
  let max = -Infinity;
  for (let i = 0; i < numClasses; i++) {
    const v = logits[offset + i];
    if (v > max) max = v;
  }
  const exps = new Float32Array(numClasses);
  let sum = 0;
  for (let i = 0; i < numClasses; i++) {
    exps[i] = Math.exp(logits[offset + i] - max);
    sum += exps[i];
  }
  for (let i = 0; i < numClasses; i++) exps[i] /= sum;
  return exps;
}

export function iou(a: VisionBBox, b: VisionBBox): number {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width);
  const y1 = Math.min(a.y + a.height, b.y + b.height);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const union = a.width * a.height + b.width * b.height - inter;
  return union <= 0 ? 0 : inter / union;
}

export interface RawCandidate {
  index: number;
  className: number;
  label: string;
  confidence: number;
  box: [number, number, number, number];
}

export function decodeDetections(inputs: DetectorInputs): RawCandidate[] {
  const { logits, predBoxes, numQueries, numClasses, width, height, threshold } = inputs;
  const candidates: RawCandidate[] = [];

  for (let q = 0; q < numQueries; q++) {
    const logitsOffset = q * numClasses;
    const probs = softmaxRow(logits, logitsOffset, numClasses);

    let maxIndex = -1;
    let maxProb = 0;
    for (let c = 1; c < numClasses; c++) {
      if (probs[c] > maxProb) {
        maxProb = probs[c];
        maxIndex = c;
      }
    }
    if (maxIndex < 0 || maxProb < threshold) continue;
    if (maxIndex === numClasses - 1) continue;
    const label = VISION_ID2LABEL[maxIndex] ?? "unknown";
    if (label === "N/A") continue;

    const [cx, cy, w, h] = predBoxes.slice(q * 4, q * 4 + 4);
    const xMin = (cx - w / 2) * width;
    const yMin = (cy - h / 2) * height;
    const boxW = w * width;
    const boxH = h * height;

    candidates.push({
      index: q,
      className: maxIndex,
      label,
      confidence: maxProb,
      box: [Math.max(0, xMin), Math.max(0, yMin), boxW, boxH],
    });
  }

  return candidates;
}

export function nonMaxSuppression(
  candidates: RawCandidate[],
  iouThreshold: number,
  maxDetections: number,
): RawCandidate[] {
  const sorted = [...candidates].sort((a, b) => b.confidence - a.confidence);
  const kept: RawCandidate[] = [];
  const toBox = (c: RawCandidate): VisionBBox => ({
    x: c.box[0],
    y: c.box[1],
    width: c.box[2],
    height: c.box[3],
  });

  while (sorted.length > 0 && kept.length < maxDetections) {
    const best = sorted.shift()!;
    kept.push(best);
    for (let i = sorted.length - 1; i >= 0; i--) {
      if (iou(toBox(best), toBox(sorted[i])) > iouThreshold) sorted.splice(i, 1);
    }
  }
  return kept;
}

export function toDetections(
  candidates: RawCandidate[],
  width: number,
  height: number,
  maxDetections: number,
  nmsIouThreshold?: number,
): VisionDetection[] {
  const nms = nmsIouThreshold != null && nmsIouThreshold > 0;
  const kept = nms ? nonMaxSuppression(candidates, nmsIouThreshold!, maxDetections) : candidates.slice(0, maxDetections);
  return kept.map((c) => {
    const [rx, ry, rw, rh] = c.box;
    const x = Math.min(Math.max(0, rx), width);
    const y = Math.min(Math.max(0, ry), height);
    const bbox: VisionBBox = {
      x,
      y,
      width: Math.min(Math.max(0, rw), width - x),
      height: Math.min(Math.max(0, rh), height - y),
    };
    return {
      type: labelToType(c.label),
      bbox,
      confidence: c.confidence,
      label: c.label,
    };
  });
}