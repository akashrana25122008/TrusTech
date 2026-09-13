import type { VisionDetectionType } from "./types";

export const MODEL_ID = "yolos-tiny";
export const MODEL_DTYPE = "q8";
export const MODEL_QUANTIZED_BYTES = 9_661_148;
export const MODEL_QUANTIZED_BYTES_HUMAN = "9.2 MB";

export const MODEL_BUDGET_BYTES = 8 * 1024 * 1024;
export const VISION_CHUNK_BUDGET_BYTES = 12 * 1024 * 1024;

export const DEFAULT_THRESHOLD = 0.5;
export const DEFAULT_MAX_DETECTIONS = 20;

export const MODEL_LONGEST_EDGE = 1333;
export const MODEL_SHORTEST_EDGE = 512;

export function labelToType(label: string): VisionDetectionType {
  switch (label) {
    case "person":
      return "face";
    case "cell phone":
    case "laptop":
    case "tv":
    case "keyboard":
      return "sensitive";
    default:
      return "element";
  }
}

export function isRedactableType(type: VisionDetectionType): boolean {
  return type !== "element";
}