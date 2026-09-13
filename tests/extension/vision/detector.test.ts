import { describe, it, expect } from "vitest";

/**
 * Vision detector — pure decode of model outputs.
 *
 * Run in jsdom like the rest of the suite: these functions are pure math
 * (softmax → threshold → top-k → NMS → xywh), so no real model needed.
 * AT-01 (vision.real-inference) covers the real model end-to-end.
 */
import {
  softmaxRow,
  iou,
  decodeDetections,
  nonMaxSuppression,
  toDetections,
  type RawCandidate,
} from "@/vision/detector";
import { labelToType, isRedactableType } from "@/vision/model";

function makeLogits(assignments: Array<{ q: number; cls: number; value: number }>, numQueries: number, numClasses: number): Float32Array {
  const data = new Float32Array(numQueries * numClasses);
  for (const { q, cls, value } of assignments) data[q * numClasses + cls] = value;
  return data;
}

function makeBoxes(boxes: Array<[number, number, number, number]>): Float32Array {
  return new Float32Array(boxes.flat());
}

describe("vision/detector — softmax", () => {
  it("normalizes logits to probabilities that sum to 1", () => {
    const row = softmaxRow(new Float32Array([2, 1, 0.5, 3]), 0, 4);
    let sum = 0;
    for (const v of row) sum += v;
    expect(sum).toBeCloseTo(1, 5);
    expect(row[3]).toBeGreaterThan(row[0]);
  });
});

describe("vision/detector — decodeDetections", () => {
  it("decodes cxcywh normalized boxes into image-relative quads with confidence + label", () => {
    const numQueries = 5;
    const numClasses = 92;
    const queries = [
      { q: 0, cls: 2, value: 8 }, // bicycle
      { q: 1, cls: 1, value: 9 }, // person → face
      { q: 2, cls: 73, value: 7 }, // laptop → sensitive
    ];
    const logits = makeLogits(queries, numQueries, numClasses);
    const boxes = makeBoxes([
      [0.5, 0.5, 0.25, 0.5], // bicycle
      [0.25, 0.25, 0.1, 0.2], // person
      [0.75, 0.75, 0.3, 0.2], // laptop
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ]);
    const decoded = decodeDetections({
      logits,
      predBoxes: boxes,
      numQueries,
      numClasses,
      width: 800,
      height: 600,
      threshold: 0.5,
      maxDetections: 20,
    });

    expect(decoded).toHaveLength(3);
    const [bicycle, person, laptop] = decoded;
    expect(bicycle.label).toBe("bicycle");
    expect(person.label).toBe("person");
    expect(laptop.label).toBe("laptop");
    // (cx - w/2) * W , (cy - h/2) * H
    expect(person.box[0]).toBeCloseTo(0.2 * 800, 5);
    expect(person.box[1]).toBeCloseTo(0.15 * 600, 5);
  });

  it("skips the background class (last index) even when its logit is high", () => {
    const numQueries = 2;
    const numClasses = 92;
    const logits = makeLogits([{ q: 0, cls: 91, value: 10 }], numQueries, numClasses);
    const boxes = makeBoxes([[0.5, 0.5, 0.2, 0.2], [0.1, 0.1, 0.1, 0.1]]);
    const decoded = decodeDetections({
      logits,
      predBoxes: boxes,
      numQueries,
      numClasses,
      width: 100,
      height: 100,
      threshold: 0.1,
      maxDetections: 20,
    });
    expect(decoded).toHaveLength(0);
  });

  it("filters below-threshold detections", () => {
    const numQueries = 1;
    const numClasses = 5;
    const logits = makeLogits([{ q: 0, cls: 2, value: 2 }], numQueries, numClasses);
    const boxes = makeBoxes([[0.5, 0.5, 0.2, 0.2]]);
    const decoded = decodeDetections({
      logits,
      predBoxes: boxes,
      numQueries,
      numClasses,
      width: 100,
      height: 100,
      threshold: 0.9,
      maxDetections: 20,
    });
    expect(decoded).toHaveLength(0);
  });
});

describe("vision/detector — NMS", () => {
  it("keeps the highest-confidence duplicate and drops the rest via IoU", () => {
    const cands: RawCandidate[] = [
      { index: 0, className: 2, label: "bicycle", confidence: 0.9, box: [10, 10, 100, 100] },
      { index: 1, className: 2, label: "bicycle", confidence: 0.8, box: [12, 12, 100, 100] },
      { index: 2, className: 2, label: "bicycle", confidence: 0.7, box: [500, 500, 40, 40] },
    ];
    const kept = nonMaxSuppression(cands, 0.5, 20);
    expect(kept).toHaveLength(2);
    expect(kept[0].index).toBe(0);
  });

  it("computes IoU correctly for disjoint and overlapping boxes", () => {
    expect(iou({ x: 0, y: 0, width: 10, height: 10 }, { x: 100, y: 100, width: 10, height: 10 })).toBe(0);
    expect(iou({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 0, width: 10, height: 10 })).toBeCloseTo(50 / 150, 5);
  });
});

describe("vision/detector — toDetections", () => {
  it("maps labels to redactable types (face, sensitive) and image-relative bbox with clamping", () => {
    const cands: RawCandidate[] = [
      { index: 0, className: 1, label: "person", confidence: 0.95, box: [-20, 10, 200, 300] },
      { index: 1, className: 73, label: "laptop", confidence: 0.6, box: [0, 0, 50, 40] },
      { index: 2, className: 5, label: "airplane", confidence: 0.5, box: [0, 0, 20, 20] },
    ];
    const dets = toDetections(cands, 400, 300, 20, 0.5);
    expect(dets).toHaveLength(3);
    expect(dets[0].type).toBe("face");
    expect(isRedactableType(dets[0].type)).toBe(true);
    expect(dets[1].type).toBe("sensitive");
    expect(isRedactableType(dets[1].type)).toBe(true);
    expect(dets[2].type).toBe("element");
    expect(isRedactableType(dets[2].type)).toBe(false);
    expect(dets[0].bbox.x).toBe(0); // clamped
    expect(dets[0].bbox.width).toBeLessThanOrEqual(400);
  });
});

describe("vision/model — label mapping", () => {
  it("maps only the privacy-relevant COCO labels", () => {
    expect(labelToType("person")).toBe("face");
    expect(labelToType("cell phone")).toBe("sensitive");
    expect(labelToType("laptop")).toBe("sensitive");
    expect(labelToType("tv")).toBe("sensitive");
    expect(labelToType("keyboard")).toBe("sensitive");
    expect(labelToType("bicycle")).toBe("element");
    expect(labelToType("dog")).toBe("element");
  });
});