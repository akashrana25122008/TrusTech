import type { AgentAction } from "@/shared/action-schema";

export type VisionActionType = "click";

export interface PixelBBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NormalizedBBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PixelPoint {
  x: number;
  y: number;
}

export interface VisualTarget {
  bbox: PixelBBox;
  normalized: NormalizedBBox;
  point: PixelPoint;
}

export interface VisualAction {
  type: VisionActionType;
  target: VisualTarget;
  confidence: number;
}

export type VisionStatus =
  | "success"
  | "target_not_found"
  | "blocked_by_privacy"
  | "low_confidence"
  | "invalid_model_output"
  | "error";

export interface VisionStepResponse {
  actions: VisualAction[];
  reason: string;
  completion: boolean;
  status: VisionStatus;
  model: string;
  redacted_regions: number;
}

const STATUSES: readonly string[] = [
  "success",
  "target_not_found",
  "blocked_by_privacy",
  "low_confidence",
  "invalid_model_output",
  "error",
];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function int(v: unknown): number | null {
  const n = num(v);
  return n !== null && Number.isInteger(n) ? n : null;
}

function validPixelBBox(v: unknown): v is PixelBBox {
  if (!isRecord(v)) return false;
  const x = int(v.x);
  const y = int(v.y);
  const w = int(v.width);
  const h = int(v.height);
  return x !== null && x >= 0 && y !== null && y >= 0 && w !== null && w > 0 && h !== null && h > 0;
}

function validNormalized(v: unknown): v is NormalizedBBox {
  if (!isRecord(v)) return false;
  const x = num(v.x);
  const y = num(v.y);
  const w = num(v.width);
  const h = num(v.height);
  return (
    x !== null && y !== null && w !== null && h !== null &&
    x >= 0 && x <= 1 && y >= 0 && y <= 1 && w > 0 && w <= 1 && h > 0 && h <= 1
  );
}

function validPoint(v: unknown): v is PixelPoint {
  if (!isRecord(v)) return false;
  const x = int(v.x);
  const y = int(v.y);
  return x !== null && x >= 0 && y !== null && y >= 0;
}

export interface VisionResponseValidation {
  ok: boolean;
  response?: VisionStepResponse;
  errors: string[];
}

export function validateVisionStepResponse(input: unknown): VisionResponseValidation {
  const errors: string[] = [];
  if (!isRecord(input)) return { ok: false, errors: ["response must be an object"] };
  if (!Array.isArray(input.actions)) return { ok: false, errors: ["actions must be an array"] };
  if (input.actions.length > 3) return { ok: false, errors: ["too many actions"] };
  if (typeof input.reason !== "string") return { ok: false, errors: ["reason must be a string"] };
  if (typeof input.completion !== "boolean") return { ok: false, errors: ["completion must be boolean"] };
  if (typeof input.status !== "string" || !STATUSES.includes(input.status)) {
    return { ok: false, errors: ["unknown status"] };
  }
  const actions: VisualAction[] = [];
  for (let i = 0; i < input.actions.length; i++) {
    const a = input.actions[i];
    if (!isRecord(a) || a.type !== "click") {
      errors.push(`actions[${i}]: only click is supported`);
      continue;
    }
    if (!isRecord(a.target) || !validPixelBBox(a.target.bbox) || !validNormalized(a.target.normalized) || !validPoint(a.target.point)) {
      errors.push(`actions[${i}]: invalid target`);
      continue;
    }
    const conf = num(a.confidence);
    if (conf === null || conf < 0 || conf > 1) {
      errors.push(`actions[${i}]: confidence out of range`);
      continue;
    }
    const t = a.target as unknown as VisualTarget;
    const inside =
      t.point.x >= t.bbox.x && t.point.x < t.bbox.x + t.bbox.width &&
      t.point.y >= t.bbox.y && t.point.y < t.bbox.y + t.bbox.height;
    if (!inside) {
      errors.push(`actions[${i}]: point outside bbox`);
      continue;
    }
    actions.push({ type: "click", target: t, confidence: conf });
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    response: {
      actions,
      reason: (input.reason as string).slice(0, 300),
      completion: input.completion as boolean,
      status: input.status as VisionStatus,
      model: typeof input.model === "string" ? (input.model as string).slice(0, 120) : "",
      redacted_regions: int(input.redacted_regions) ?? 0,
    },
  };
}

export interface ViewportPoint {
  x: number;
  y: number;
}

export function imagePointToViewport(
  point: PixelPoint,
  image: { width: number; height: number },
  viewport: { width: number; height: number },
): ViewportPoint | null {
  if (image.width <= 0 || image.height <= 0 || viewport.width <= 0 || viewport.height <= 0) return null;
  if (point.x < 0 || point.y < 0 || point.x >= image.width || point.y >= image.height) return null;
  return {
    x: Math.round((point.x / image.width) * viewport.width * 10) / 10,
    y: Math.round((point.y / image.height) * viewport.height * 10) / 10,
  };
}

export function visionActionToAgentAction(action: VisualAction): AgentAction {
  return { action: "click", confidence: action.confidence };
}
