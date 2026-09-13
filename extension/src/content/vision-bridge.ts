import { executeAction } from "./executor";
import { groundVisualTarget, type VisualGroundingRequest } from "./visual-grounding";
import type { ActionResult } from "@/shared/messages";

export interface VisionPointPayload {
  point?: { x: number; y: number };
  image: { width: number; height: number };
  confidence?: number;
  bbox?: { x: number; y: number; width: number; height: number };
  normalized?: { x: number; y: number; width: number; height: number };
  coordinateSpace?: VisualGroundingRequest["coordinateSpace"];
  viewport?: { width: number; height: number };
  dpr?: number;
  scroll?: { x: number; y: number };
  crop?: { x: number; y: number };
  captureId?: string;
  capturedAt?: number;
  url?: string;
  label?: string;
}

export interface VisionPointResult {
  ok: boolean;
  viewport?: { x: number; y: number };
  grounding?: { status: string; elementId?: string; method?: string; reason?: string };
  execution?: ActionResult;
  error?: string;
}

export async function groundVisionPoint(payload: VisionPointPayload): Promise<VisionPointResult> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return { ok: false, error: "no document" };
  }
  const grounded = groundVisualTarget({
    action: "click",
    bbox: payload.bbox,
    normalized: payload.normalized,
    point: payload.point,
    coordinateSpace: payload.coordinateSpace ?? "screenshot_pixels",
    image: payload.image,
    viewport: payload.viewport,
    dpr: payload.dpr,
    scroll: payload.scroll,
    crop: payload.crop,
    captureId: payload.captureId,
    capturedAt: payload.capturedAt,
    url: payload.url,
    visionConfidence: payload.confidence,
    label: payload.label,
  });
  const legacyPointOnly = payload.bbox === undefined && payload.normalized === undefined;
  if (!grounded.ok || !grounded.action || !grounded.elementId) {
    const error =
      legacyPointOnly && grounded.code === "COORDINATE_OUT_OF_BOUNDS"
        ? "point outside image"
        : legacyPointOnly && grounded.code === "TARGET_NOT_FOUND"
          ? "no element at point"
          : (grounded.reason ?? grounded.code ?? "grounding failed");
    return {
      ok: false,
      viewport: grounded.viewportPoint,
      grounding: { status: "not_found", reason: grounded.code ?? grounded.reason },
      error,
    };
  }
  const execution = await executeAction(grounded.action, grounded.elementId);
  return {
    ok: execution.ok,
    viewport: legacyPointOnly && payload.point ? payload.point : grounded.viewportPoint,
    grounding: { status: "ok", elementId: grounded.elementId, method: "id", reason: grounded.elementName },
    execution,
    error: execution.ok ? undefined : execution.error,
  };
}
