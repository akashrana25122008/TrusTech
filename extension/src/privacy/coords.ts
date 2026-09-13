/* ------------------------------------------------------------------ *
 * Coordinate system — ONE canonical system for SensitiveRegion:
 *
 *   captured-image-relative (image), i.e. the full screenshot raster
 *   dims passed as `image: RegionSize`.
 *
 * Raw coordinates are NEVER compared across systems. Every source is
 * reduced to image space before fusion (see privacy-analyzer.ts).
 *
 *   viewport → image : scale = sourceWidth / viewportWidth
 *   ocr      → image : scale = sourceWidth / ocrWidth
 *   image    → viewport / pane : inverse
 * ------------------------------------------------------------------ */

import type { RegionBBox, RegionSize } from "./regions";

export interface ViewportScale {
  viewport: RegionSize;
  image: RegionSize;
}

export interface OcRasterScale {
  ocr: RegionSize;
  image: RegionSize;
}

/** IoU for two axis-aligned boxes (RegionBBox flavor). */
export function iouRect(a: RegionBBox, b: RegionBBox): number {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width);
  const y1 = Math.min(a.y + a.height, b.y + b.height);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const union = a.width * a.height + b.width * b.height - inter;
  return union <= 0 ? 0 : inter / union;
}

/**
 * Spatial alignment between two regions. True when IoU passes the
 * merge threshold OR one box is contained by the other such that the
 * smaller one is ≥ REGION_CONTAINMENT_FRACTION covered (small boxes
 * have noisy IoU, containment is the fair signal for them).
 */
export function regionsAligned(a: RegionBBox, b: RegionBBox, iou = 0.3, containment = 0.6): boolean {
  if (iouRect(a, b) >= iou) return true;
  const areaA = a.width * a.height;
  const areaB = b.width * b.height;
  if (areaA <= 0 || areaB <= 0) return false;
  const inter = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const minArea = Math.min(areaA, areaB);
  return minArea > 0 && inter / minArea >= containment;
}

export function viewportToImage(bbox: RegionBBox, scale: ViewportScale): RegionBBox {
  const sx = scale.viewport.width > 0 ? scale.image.width / scale.viewport.width : 1;
  const sy = scale.viewport.height > 0 ? scale.image.height / scale.viewport.height : 1;
  return scaledBBox(bbox, sx, sy);
}

export function imageToViewport(bbox: RegionBBox, scale: ViewportScale): RegionBBox {
  const sx = scale.image.width > 0 ? scale.viewport.width / scale.image.width : 1;
  const sy = scale.image.height > 0 ? scale.viewport.height / scale.image.height : 1;
  return scaledBBox(bbox, sx, sy);
}

export function ocrToImage(bbox: RegionBBox, scale: OcRasterScale): RegionBBox {
  const sx = scale.ocr.width > 0 ? scale.image.width / scale.ocr.width : 1;
  const sy = scale.ocr.height > 0 ? scale.image.height / scale.ocr.height : 1;
  return scaledBBox(bbox, sx, sy);
}

export function scaledBBox(bbox: RegionBBox, sx: number, sy: number): RegionBBox {
  return {
    x: Math.max(0, Math.round(bbox.x * sx * 10) / 10),
    y: Math.max(0, Math.round(bbox.y * sy * 10) / 10),
    width: Math.round(bbox.width * sx * 10) / 10,
    height: Math.round(bbox.height * sy * 10) / 10,
  };
}

/** 0..1 normalized box against a canonical image size. */
export function normalizeBBox(bbox: RegionBBox, image: RegionSize): RegionBBox {
  return {
    x: image.width > 0 ? bbox.x / image.width : 0,
    y: image.height > 0 ? bbox.y / image.height : 0,
    width: image.width > 0 ? bbox.width / image.width : 0,
    height: image.height > 0 ? bbox.height / image.height : 0,
  };
}

/** Union box of two regions (used when mapping a text span onto a field). */
export function unionBBox(a: RegionBBox, b: RegionBBox): RegionBBox {
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.width, b.x + b.width);
  const y1 = Math.max(a.y + a.height, b.y + b.height);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** True when two boxes are considered "duplicate" for GT/metric matching. */
export function matchesGroundTruth(pred: RegionBBox, gt: RegionBBox): boolean {
  return regionsAligned(pred, gt);
}