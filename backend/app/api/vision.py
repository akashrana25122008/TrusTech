"""Sanitized-image intake — POST /api/agent/vision.

Defense-in-depth receiver for the client-side privacy boundary. The
extension gate only ever sends verified sanitized PNGs with a validated
redaction manifest; this endpoint validates everything AGAIN and then
DISCARDS the bytes (screenshots are never persisted server-side).

Accepted shapes (both validated identically):
  Phase 4 full contract:
    {"task": {"goal": …}, "visual_context": {"image": …, "width": …,
     "height": …}, "redaction_manifest": {…}, "vision_metadata": {…}}
  Legacy flat shape:
    {"image": …, "manifest": {…}}

  valid manifest + valid PNG (+ valid metadata/dims when present) → 200
  anything else → 422.

Client-side RAW IMAGE → BLOCK remains mandatory regardless of this
endpoint; server validation is a second lock, never a permission.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from backend.app.privacy.image_manifest import (
    MANIFEST_VERSION,
    decode_png_data_url,
    manifest_fits_image,
    png_dimensions,
    validate_manifest,
    validate_vision_metadata,
)

router = APIRouter(tags=["vision"])


class TaskPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    goal: str = Field(min_length=1, max_length=2000)
    intent: str | None = Field(default=None, max_length=200)
    url: str | None = Field(default=None, max_length=2000)
    tabId: int | None = None


class VisualContext(BaseModel):
    model_config = ConfigDict(extra="forbid")

    image: str = Field(min_length=32, max_length=12 * 1024 * 1024)
    width: int = Field(gt=0, le=8192)
    height: int = Field(gt=0, le=8192)


class VisionMetadata(BaseModel):
    model_config = ConfigDict(extra="forbid")

    model: str = Field(min_length=1, max_length=64)
    model_version: str = Field(min_length=1, max_length=32)
    runtime: str = Field(min_length=1, max_length=32)
    backend: str = Field(min_length=1, max_length=16)
    inference_latency_ms: float = Field(ge=0, le=600_000)
    detections: int = Field(ge=0, le=10_000)
    capture_width: int = Field(gt=0, le=8192)
    capture_height: int = Field(gt=0, le=8192)


class VisionIntake(BaseModel):
    """Legacy flat shape: {"image", "manifest"} — still accepted."""

    model_config = ConfigDict(extra="forbid")

    image: str = Field(min_length=32, max_length=12 * 1024 * 1024)
    manifest: dict[str, Any]


class VisualIntake(BaseModel):
    """Phase 4 full contract."""

    model_config = ConfigDict(extra="forbid")

    task: TaskPayload
    visual_context: VisualContext
    redaction_manifest: dict[str, Any]
    vision_metadata: VisionMetadata


def _accept(image: str, manifest: dict[str, Any], metadata: dict[str, Any] | None):
    manifest_errors = validate_manifest(manifest)
    if manifest_errors:
        return JSONResponse(
            status_code=422,
            content={"detail": "invalid redaction manifest", "errors": manifest_errors[:8]},
        )

    png, png_error = decode_png_data_url(image)
    if png is None:
        return JSONResponse(status_code=422, content={"detail": png_error or "invalid image envelope"})
    width, height = png_dimensions(png)
    if width is None or height is None:
        return JSONResponse(status_code=422, content={"detail": "unreadable PNG header"})

    fit_errors = manifest_fits_image(manifest, width, height)
    if fit_errors:
        return JSONResponse(status_code=422, content={"detail": "manifest/image mismatch", "errors": fit_errors[:8]})

    meta_errors = validate_vision_metadata(metadata) if metadata is not None else []
    if meta_errors:
        return JSONResponse(
            status_code=422,
            content={"detail": "invalid vision metadata", "errors": meta_errors[:8]},
        )

    # Bytes are deliberately NOT stored. Receipt only.
    regions = manifest.get("regions", [])
    return {
        "received": True,
        "manifest_version": MANIFEST_VERSION,
        "regions": len(regions) if isinstance(regions, list) else 0,
        "image": {"width": width, "height": height, "bytes": len(png)},
    }


@router.post("/api/agent/vision")
def intake_vision(payload: dict[str, Any]):
    if not isinstance(payload, dict):
        return JSONResponse(status_code=422, content={"detail": "payload must be an object"})
    keys = set(payload.keys())
    if keys == {"task", "visual_context", "redaction_manifest", "vision_metadata"}:
        try:
            full = VisualIntake.model_validate(payload)
        except Exception as exc:
            return JSONResponse(status_code=422, content={"detail": "invalid visual payload", "errors": [str(exc)[:300]]})
        vc = full.visual_context
        if vc.width <= 0 or vc.height <= 0:
            return JSONResponse(status_code=422, content={"detail": "invalid visual_context dimensions"})
        result = _accept(vc.image, full.redaction_manifest, full.vision_metadata.model_dump())
        if isinstance(result, dict):
            png_len = len(vc.image)
            result["declared"] = {"width": vc.width, "height": vc.height}
            if result["image"]["width"] != vc.width or result["image"]["height"] != vc.height:
                return JSONResponse(status_code=422, content={"detail": "visual_context dimensions mismatch PNG"})
            result["payload_bytes"] = png_len
        return result
    if keys == {"image", "manifest"}:
        try:
            legacy = VisionIntake.model_validate(payload)
        except Exception as exc:
            return JSONResponse(status_code=422, content={"detail": "invalid image payload", "errors": [str(exc)[:300]]})
        return _accept(legacy.image, legacy.manifest, None)
    return JSONResponse(status_code=422, content={"detail": "unknown visual payload shape"})
