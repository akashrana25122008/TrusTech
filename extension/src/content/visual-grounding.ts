import { assessAction } from "@/agent/risk-manager";
import { SAFETY_THRESHOLDS } from "@/agent/safety-policy";
import type { AgentAction } from "@/shared/action-schema";
import { accessibleName, inferRole, isEnabled, isVisible } from "./accessibility-reader";
import { groundTarget } from "./grounder";
import { indexElement } from "./indexer";

export type VisualCoordinateSpace = "screenshot_pixels" | "viewport_css" | "page_css" | "device_pixels";

export type VisualActionKind = "click" | "type" | "select" | "hover" | "focus" | "scroll" | "submit";

export type VisualGroundingCode =
  | "BBOX_INVALID"
  | "COORDINATE_SPACE_UNKNOWN"
  | "COORDINATE_OUT_OF_BOUNDS"
  | "TARGET_NOT_FOUND"
  | "TARGET_IN_FRAME"
  | "DOM_TARGET_MISMATCH"
  | "TARGET_OCCLUDED"
  | "TARGET_NOT_VISIBLE"
  | "TARGET_DISABLED"
  | "TARGET_NOT_EDITABLE"
  | "STALE_CAPTURE"
  | "VIEWPORT_CHANGED"
  | "LOW_CONFIDENCE"
  | "RISK_BLOCKED"
  | "CONFIRMATION_REQUIRED";

export interface VisualBboxInput {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VisualGroundingRequest {
  action: VisualActionKind;
  bbox?: VisualBboxInput | [number, number, number, number];
  normalized?: { x: number; y: number; width: number; height: number };
  point?: { x: number; y: number };
  coordinateSpace: VisualCoordinateSpace;
  image: { width: number; height: number };
  viewport?: { width: number; height: number };
  dpr?: number;
  scroll?: { x: number; y: number };
  crop?: { x: number; y: number };
  captureId?: string;
  capturedAt?: number;
  url?: string;
  visionConfidence?: number;
  label?: string;
  text?: string;
  option?: string;
}

export interface VisualGroundingEvidence {
  captureId?: string;
  ageMs?: number;
  dpr: number;
  dprChanged: boolean;
  scrollDelta: { x: number; y: number };
  viewportChanged: boolean;
  iou: number;
  labelAgreement: number;
}

export interface VisualGroundingResult {
  ok: boolean;
  code?: VisualGroundingCode;
  viewportPoint?: { x: number; y: number };
  mappedBbox?: VisualBboxInput;
  elementId?: string;
  elementRole?: string;
  elementName?: string;
  visionConfidence: number;
  targetConfidence: number;
  riskLevel?: string;
  requiresConfirmation?: boolean;
  action?: AgentAction;
  reason?: string;
  evidence: VisualGroundingEvidence;
}

const VISUAL_ACTIONS: ReadonlySet<string> = new Set(["click", "type", "select", "hover", "focus", "scroll", "submit"]);

const ACTIONABLE_ROLES: ReadonlySet<string> = new Set([
  "button", "link", "textbox", "searchbox", "combobox", "listbox", "checkbox", "radio",
  "switch", "tab", "menuitem", "option", "slider", "spinbutton",
]);

const ACTIONABLE_TAGS: ReadonlySet<string> = new Set(["button", "a", "input", "select", "textarea"]);

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function normalizeVisualBbox(
  bbox: VisualBboxInput | [number, number, number, number] | undefined,
  normalized: { x: number; y: number; width: number; height: number } | undefined,
  image: { width: number; height: number },
): VisualBboxInput | null {
  let box: VisualBboxInput | null = null;
  if (Array.isArray(bbox)) {
    if (bbox.length !== 4) return null;
    const [x, y, w, h] = bbox;
    if ([x, y, w, h].some((v) => typeof v !== "number" || !Number.isFinite(v))) return null;
    box = { x, y, width: w, height: h };
  } else if (bbox && typeof bbox === "object") {
    const vals = [num(bbox.x), num(bbox.y), num(bbox.width), num(bbox.height)];
    if (vals.some((v) => v === null)) return null;
    box = { x: vals[0]!, y: vals[1]!, width: vals[2]!, height: vals[3]! };
  } else if (normalized && typeof normalized === "object") {
    const vals = [num(normalized.x), num(normalized.y), num(normalized.width), num(normalized.height)];
    if (vals.some((v) => v === null)) return null;
    if (vals[0]! < 0 || vals[0]! > 1 || vals[1]! < 0 || vals[1]! > 1 || vals[2]! <= 0 || vals[2]! > 1 || vals[3]! <= 0 || vals[3]! > 1) {
      return null;
    }
    box = { x: vals[0]! * image.width, y: vals[1]! * image.height, width: vals[2]! * image.width, height: vals[3]! * image.height };
  }
  if (!box) return null;
  if (!(box.width > 0) || !(box.height > 0)) return null;
  return box;
}

export interface ViewportGeometry {
  width: number;
  height: number;
  dpr: number;
  scrollX: number;
  scrollY: number;
}

export function liveGeometry(): ViewportGeometry | null {
  if (typeof window === "undefined" || typeof document === "undefined") return null;
  const dpr = typeof window.devicePixelRatio === "number" && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
  return { width: window.innerWidth, height: window.innerHeight, dpr, scrollX: window.scrollX, scrollY: window.scrollY };
}

export function mapToViewportCss(
  box: VisualBboxInput,
  space: VisualCoordinateSpace,
  image: { width: number; height: number },
  live: ViewportGeometry,
  crop?: { x: number; y: number },
): VisualBboxInput | null {
  const cx = crop?.x ?? 0;
  const cy = crop?.y ?? 0;
  const shifted = { x: box.x + cx, y: box.y + cy, width: box.width, height: box.height };
  if (image.width <= 0 || image.height <= 0) return null;
  switch (space) {
    case "screenshot_pixels": {
      if (live.width <= 0 || live.height <= 0) return null;
      const sx = live.width / image.width;
      const sy = live.height / image.height;
      return { x: shifted.x * sx, y: shifted.y * sy, width: shifted.width * sx, height: shifted.height * sy };
    }
    case "device_pixels":
      return { x: shifted.x / live.dpr, y: shifted.y / live.dpr, width: shifted.width / live.dpr, height: shifted.height / live.dpr };
    case "viewport_css":
      return { ...shifted };
    case "page_css":
      return { x: shifted.x - live.scrollX, y: shifted.y - live.scrollY, width: shifted.width, height: shifted.height };
    default:
      return null;
  }
}

function centerOf(box: VisualBboxInput): { x: number; y: number } {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

function areaInside(box: VisualBboxInput, live: ViewportGeometry): number {
  const x0 = Math.max(0, box.x);
  const y0 = Math.max(0, box.y);
  const x1 = Math.min(live.width, box.x + box.width);
  const y1 = Math.min(live.height, box.y + box.height);
  const area = box.width * box.height;
  if (area <= 0) return 0;
  return (Math.max(0, x1 - x0) * Math.max(0, y1 - y0)) / area;
}

function iou(a: VisualBboxInput, b: VisualBboxInput): number {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width);
  const y1 = Math.min(a.y + a.height, b.y + b.height);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? inter / union : 0;
}

function elRect(el: Element): VisualBboxInput {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

function resolveActionable(start: Element): Element | null {
  let el: Element | null = start;
  for (let depth = 0; depth < 6 && el; depth++) {
    const tag = el.tagName.toLowerCase();
    if (ACTIONABLE_TAGS.has(tag) || ACTIONABLE_ROLES.has(inferRole(el))) return el;
    el = el.parentElement;
  }
  return null;
}

function coveredActionableExists(center: { x: number; y: number }): boolean {
  let found = false;
  try {
    const candidates = document.querySelectorAll("button, a, input, select, textarea, [role=button], [role=link]");
    for (const el of Array.from(candidates).slice(0, 500)) {
      const r = el.getBoundingClientRect();
      if (center.x >= r.x && center.y >= r.y && center.x < r.x + r.width && center.y < r.y + r.height) {
        found = true;
        break;
      }
    }
  } catch {
    found = false;
  }
  return found;
}

function labelAgreement(label: string | undefined, el: Element): number {
  if (!label || !label.trim()) return 0.5;
  const haystack = `${accessibleName(el)} ${el.textContent ?? ""} ${el.getAttribute?.("aria-label") ?? ""} ${el.getAttribute?.("title") ?? ""}`.toLowerCase();
  if (!haystack.trim()) return 0.5;
  const tokens = label.toLowerCase().split(/\W+/).filter((t) => t.length > 2);
  if (tokens.length === 0) return 0.5;
  const hits = tokens.filter((t) => haystack.includes(t)).length;
  return hits / tokens.length;
}

function fail(
  code: VisualGroundingCode,
  reason: string,
  evidence: VisualGroundingEvidence,
  visionConfidence: number,
): VisualGroundingResult {
  return { ok: false, code, reason, visionConfidence, targetConfidence: 0, evidence };
}

export function groundVisualTarget(req: VisualGroundingRequest): VisualGroundingResult {
  const live = liveGeometry();
  const visionConfidence =
    typeof req.visionConfidence === "number" && Number.isFinite(req.visionConfidence)
      ? Math.max(0, Math.min(1, req.visionConfidence))
      : 0.4;
  const evidence: VisualGroundingEvidence = {
    captureId: req.captureId,
    ageMs: req.capturedAt !== undefined ? Math.max(0, Date.now() - req.capturedAt) : undefined,
    dpr: live?.dpr ?? 1,
    dprChanged: req.dpr !== undefined && live !== null && req.dpr !== live.dpr,
    scrollDelta: { x: 0, y: 0 },
    viewportChanged: false,
    iou: 0,
    labelAgreement: 0.5,
  };
  if (!VISUAL_ACTIONS.has(req.action)) {
    return fail("BBOX_INVALID", `unsupported visual action: ${req.action}`, evidence, visionConfidence);
  }
  if (!live) return fail("TARGET_NOT_FOUND", "no live viewport", evidence, visionConfidence);
  if (req.url !== undefined && req.url !== window.location.href) {
    return fail("STALE_CAPTURE", "page changed since capture", evidence, visionConfidence);
  }
  if (req.viewport !== undefined && (Math.abs(req.viewport.width - live.width) > 1 || Math.abs(req.viewport.height - live.height) > 1)) {
    evidence.viewportChanged = true;
    return fail("VIEWPORT_CHANGED", "viewport changed since capture", evidence, visionConfidence);
  }
  if (
    req.coordinateSpace !== "screenshot_pixels" &&
    req.coordinateSpace !== "viewport_css" &&
    req.coordinateSpace !== "page_css" &&
    req.coordinateSpace !== "device_pixels"
  ) {
    return fail("COORDINATE_SPACE_UNKNOWN", "unknown coordinate space", evidence, visionConfidence);
  }
  let source: VisualBboxInput | null = normalizeVisualBbox(req.bbox, req.normalized, req.image);
  let hasExtent = source !== null;
  if (!source && req.point && num(req.point.x) !== null && num(req.point.y) !== null) {
    source = { x: req.point.x, y: req.point.y, width: 1, height: 1 };
  }
  if (!source) return fail("BBOX_INVALID", "malformed bounding box", evidence, visionConfidence);
  if (req.scroll !== undefined) {
    evidence.scrollDelta = { x: live.scrollX - req.scroll.x, y: live.scrollY - req.scroll.y };
  }
  const mapped = mapToViewportCss(source, req.coordinateSpace, req.image, live, req.crop);
  if (!mapped) return fail("COORDINATE_OUT_OF_BOUNDS", "mapping failed", evidence, visionConfidence);
  const center = centerOf(mapped);
  const insideViewport =
    center.x >= 0 && center.y >= 0 && center.x < live.width && center.y < live.height && areaInside(mapped, live) >= 0.5;
  if (!insideViewport) return fail("COORDINATE_OUT_OF_BOUNDS", "target outside actionable viewport", evidence, visionConfidence);
  if (typeof document.elementFromPoint !== "function") {
    return fail("TARGET_NOT_FOUND", "element query unavailable", evidence, visionConfidence);
  }
  let hit = document.elementFromPoint(center.x, center.y);
  if (!hit) return fail("TARGET_NOT_FOUND", "no element at target point", evidence, visionConfidence);
  if (hit instanceof HTMLIFrameElement) return fail("TARGET_IN_FRAME", "target is inside a frame", evidence, visionConfidence);
  const shadow = (hit as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
  if (shadow && typeof shadow.elementFromPoint === "function") {
    hit = shadow.elementFromPoint(center.x, center.y) ?? hit;
    if (hit instanceof HTMLIFrameElement) return fail("TARGET_IN_FRAME", "target is inside a frame", evidence, visionConfidence);
  }
  const actionable = resolveActionable(hit);
  if (!actionable) {
    return fail(
      coveredActionableExists(center) ? "TARGET_OCCLUDED" : "DOM_TARGET_MISMATCH",
      coveredActionableExists(center) ? "target is covered by another element" : "no actionable ancestor at target point",
      evidence,
      visionConfidence,
    );
  }
  if (hit !== actionable && !actionable.contains(hit)) {
    return fail("TARGET_OCCLUDED", "top element is outside the actionable target", evidence, visionConfidence);
  }
  if (!isVisible(actionable)) return fail("TARGET_NOT_VISIBLE", "target is not visible", evidence, visionConfidence);
  if (!isEnabled(actionable)) return fail("TARGET_DISABLED", "target is disabled", evidence, visionConfidence);
  if (req.action === "type") {
    const tag = actionable.tagName.toLowerCase();
    const editable =
      actionable instanceof HTMLInputElement || actionable instanceof HTMLTextAreaElement || (actionable as HTMLElement).isContentEditable;
    if (!editable && inferRole(actionable) !== "textbox" && inferRole(actionable) !== "searchbox" && tag !== "input" && tag !== "textarea") {
      return fail("TARGET_NOT_EDITABLE", "type target is not editable", evidence, visionConfidence);
    }
  }
  if (req.action === "select") {
    const tag = actionable.tagName.toLowerCase();
    if (tag !== "select" && inferRole(actionable) !== "listbox" && inferRole(actionable) !== "combobox") {
      return fail("DOM_TARGET_MISMATCH", "select target is not a select control", evidence, visionConfidence);
    }
  }
  const rect = elRect(actionable);
  const overlap = iou(mapped, rect);
  const agreement = labelAgreement(req.label, actionable);
  evidence.iou = Math.round(overlap * 100) / 100;
  evidence.labelAgreement = Math.round(agreement * 100) / 100;
  if (req.label !== undefined && req.label.trim().length > 0 && agreement === 0) {
    return fail("DOM_TARGET_MISMATCH", "element does not match the intended target", evidence, visionConfidence);
  }
  const iouPart = hasExtent ? Math.min(1, overlap * 2) : 0.5;
  const targetConfidence = Math.round(((iouPart + agreement) / 2) * 100) / 100;
  const combined = (visionConfidence + targetConfidence) / 2;
  if (combined < SAFETY_THRESHOLDS.medium) {
    return fail("LOW_CONFIDENCE", "combined grounding confidence below policy threshold", evidence, visionConfidence);
  }
  const role = inferRole(actionable);
  const name = (accessibleName(actionable) ?? "").trim().slice(0, 120);
  const spec: Record<string, string> = {};
  if (role) spec.role = role;
  if (name) spec.name = name;
  const action: AgentAction = { action: req.action, confidence: visionConfidence };
  if (Object.keys(spec).length > 0) action.target = spec as AgentAction["target"];
  if (req.action === "type" && req.text !== undefined) action.text = req.text;
  if (req.action === "select" && req.option !== undefined) action.option = req.option;
  const grounded = action.target ? groundTarget(action.target) : null;
  if (grounded && grounded.status === "ok" && grounded.elementId) {
    action.target = { elementId: grounded.elementId };
  }
  const risk = assessAction({ ...action, target: { ...action.target, role, name } }, undefined);
  if ((risk.level === "HIGH" || risk.level === "CRITICAL") && risk.requiresConfirmation) {
    return {
      ok: false,
      code: "CONFIRMATION_REQUIRED",
      viewportPoint: center,
      mappedBbox: { x: Math.round(mapped.x), y: Math.round(mapped.y), width: Math.round(mapped.width), height: Math.round(mapped.height) },
      elementRole: role,
      elementName: name,
      visionConfidence,
      targetConfidence,
      riskLevel: risk.level,
      requiresConfirmation: true,
      reason: risk.reasons.join("; "),
      evidence,
    };
  }
  const elementId =
    grounded && grounded.status === "ok" && grounded.elementId ? grounded.elementId : indexElement(actionable);
  return {
    ok: true,
    viewportPoint: center,
    mappedBbox: { x: Math.round(mapped.x), y: Math.round(mapped.y), width: Math.round(mapped.width), height: Math.round(mapped.height) },
    elementId,
    elementRole: role,
    elementName: name,
    visionConfidence,
    targetConfidence,
    riskLevel: risk.level,
    requiresConfirmation: risk.requiresConfirmation,
    action: { ...action, target: { elementId } },
    evidence,
  };
}
