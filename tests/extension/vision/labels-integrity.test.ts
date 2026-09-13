// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { VISION_ID2LABEL } from "@/vision/labels";

/**
 * Integrity check: the bundled label map must be EXACTLY the id2label table
 * from the ONNX checkpoint's config.json that ships in extension/public/models.
 * This proves the detector's label mapping is derived from the real model —
 * not hand-copied or mistranscribed.
 */
const CONFIG = resolve(process.cwd(), "extension/public/models/yolos-tiny/config.json");

describe("vision/labels — derived from the real checkpoint config", () => {
  it("id2label exactly matches the shipped config.json", () => {
    const cfg = JSON.parse(readFileSync(CONFIG, "utf8")) as { id2label: Record<string, string> };
    const expected: Record<number, string> = {};
    for (const [k, v] of Object.entries(cfg.id2label)) expected[Number(k)] = v;
    expect(VISION_ID2LABEL).toEqual(expected);
  });

  it("contains the labels the labelToType mapping depends on", () => {
    for (const label of ["person", "cell phone", "laptop", "tv", "keyboard", "cat"]) {
      expect(Object.values(VISION_ID2LABEL)).toContain(label);
    }
  });
});