from __future__ import annotations

import json
import math
from typing import Any

from backend.app.schemas.vision_step import MAX_ACTIONS, MIN_EXECUTABLE_CONFIDENCE


def parse_model_json(raw: str) -> dict[str, Any]:
    text = raw.strip()
    if text.startswith("```"):
        lines = text.split("\n")
        lines = lines[1:-1] if lines[-1].strip().startswith("```") else lines[1:]
        text = "\n".join(lines).strip()
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError(f"model output is not JSON: {exc}") from None
    if not isinstance(parsed, dict):
        raise ValueError("model output must be a JSON object")
    return parsed


def _finite_number(v: Any) -> float | None:
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) else None


def normalize_target(target: Any, width: int, height: int) -> dict[str, Any] | None:
    if not isinstance(target, dict):
        return None
    bbox = target.get("bbox")
    norm = target.get("normalized")
    point = target.get("point")
    if not all(isinstance(p, dict) for p in (bbox, norm, point)):
        return None
    try:
        bx, by, bw, bh = (int(bbox[k]) for k in ("x", "y", "width", "height"))
        nx, ny, nw, nh = (float(norm[k]) for k in ("x", "y", "width", "height"))
        px, py = (int(point[k]) for k in ("x", "y"))
    except (KeyError, TypeError, ValueError):
        return None
    for v in (nx, ny, nw, nh):
        if not math.isfinite(v):
            return None
    if not (0.0 <= nx <= 1.0 and 0.0 <= ny <= 1.0 and 0.0 < nw <= 1.0 and 0.0 < nh <= 1.0):
        return None
    ex, ey = round(nx * width), round(ny * height)
    ew, eh = max(1, round(nw * width)), max(1, round(nh * height))
    if abs(ex - bx) > max(2, bw // 4) or abs(ey - by) > max(2, bh // 4):
        bx, by, bw, bh = ex, ey, ew, eh
    if bx < 0 or by < 0 or bw <= 0 or bh <= 0 or bx + bw > width or by + bh > height:
        return None
    if not (bx <= px < bx + bw and by <= py < by + bh):
        px, py = bx + bw // 2, by + bh // 2
    return {
        "bbox": {"x": bx, "y": by, "width": bw, "height": bh},
        "normalized": {"x": round(bx / width, 4), "y": round(by / height, 4), "width": round(bw / width, 4), "height": round(bh / height, 4)},
        "point": {"x": px, "y": py},
    }


def normalize_actions(parsed: Any, width: int, height: int) -> tuple[list[dict[str, Any]], str, bool]:
    if not isinstance(parsed, dict):
        raise ValueError("model output must be a JSON object")
    raw_actions = parsed.get("actions", [])
    if not isinstance(raw_actions, list):
        raise ValueError("actions must be a list")
    reason = parsed.get("reason")
    reason = reason.strip()[:300] if isinstance(reason, str) and reason.strip() else "visual grounding"
    completion = parsed.get("completion") is True
    actions: list[dict[str, Any]] = []
    for entry in raw_actions[:MAX_ACTIONS]:
        if not isinstance(entry, dict) or entry.get("type") != "click":
            continue
        conf = _finite_number(entry.get("confidence"))
        if conf is None or not 0.0 <= conf <= 1.0:
            continue
        target = normalize_target(entry.get("target"), width, height)
        if target is None:
            continue
        actions.append({"type": "click", "target": target, "confidence": round(conf, 4)})
    return actions, reason, completion


def point_in_rect(px: int, py: int, bbox: list[int]) -> bool:
    x, y, w, h = bbox
    return x <= px < x + w and y <= py < y + h


def bbox_iou(a: list[int], b: list[int]) -> float:
    x0, y0 = max(a[0], b[0]), max(a[1], b[1])
    x1, y1 = min(a[0] + a[2], b[0] + b[2]), min(a[1] + a[3], b[1] + b[3])
    inter = max(0, x1 - x0) * max(0, y1 - y0)
    union = a[2] * a[3] + b[2] * b[3] - inter
    return inter / union if union > 0 else 0.0


def target_overlaps_manifest(target: dict[str, Any], regions: list[dict[str, Any]]) -> dict[str, Any] | None:
    point = target["point"]
    box = [target["bbox"]["x"], target["bbox"]["y"], target["bbox"]["width"], target["bbox"]["height"]]
    for region in regions:
        rbbox = region.get("bbox")
        if not isinstance(rbbox, list) or len(rbbox) != 4:
            continue
        if point_in_rect(point["x"], point["y"], rbbox) or bbox_iou(box, rbbox) >= 0.05:
            return region
    return None


def authorize_actions(
    actions: list[dict[str, Any]], regions: list[dict[str, Any]], min_confidence: float = MIN_EXECUTABLE_CONFIDENCE
) -> tuple[list[dict[str, Any]], str]:
    allowed: list[dict[str, Any]] = []
    for action in actions:
        if action["confidence"] < min_confidence:
            return [], "low_confidence"
        hit = target_overlaps_manifest(action["target"], regions)
        if hit is not None:
            return [], "blocked_by_privacy"
        allowed.append(action)
    return allowed, "success"
