from __future__ import annotations

import logging
import time

from fastapi import APIRouter, HTTPException

from backend.app.privacy.image_manifest import (
    decode_png_data_url,
    manifest_fits_image,
    png_dimensions,
    validate_manifest,
)
from backend.app.schemas.vision_step import VisionStatus, VisionStepRequest, VisionStepResponse
from backend.app.services.config import get_settings
from backend.app.services.vision.gemini_vision import GeminiVisionProvider
from backend.app.services.vision.service import VisionService

logger = logging.getLogger("trustech.vision_step")

router = APIRouter(tags=["vision"])


def _vision_service() -> VisionService:
    settings = get_settings()
    provider = GeminiVisionProvider(
        api_key=str(getattr(settings, "gemini_api_key", "") or ""),
        model=str(getattr(settings, "gemini_model", "gemini-2.0-flash") or "gemini-2.0-flash"),
        timeout_s=float(getattr(settings, "ai_provider_timeout_s", 25.0) or 25.0),
    )
    return VisionService(provider)


@router.post("/vision_step", response_model=VisionStepResponse)
async def vision_step(req: VisionStepRequest) -> VisionStepResponse:
    start = time.perf_counter()
    manifest = req.redaction_manifest.model_dump()
    errors = validate_manifest(manifest)
    if errors:
        raise HTTPException(status_code=422, detail=f"invalid redaction manifest: {errors[0]}")

    png, png_error = decode_png_data_url(req.visual_context.image)
    if png is None:
        raise HTTPException(status_code=422, detail=png_error or "invalid image envelope")
    width, height = png_dimensions(png)
    if width is None or height is None:
        raise HTTPException(status_code=422, detail="unreadable PNG header")
    vc = req.visual_context
    if width != vc.width or height != vc.height:
        raise HTTPException(status_code=422, detail="declared dimensions differ from decoded image")
    fit = manifest_fits_image(manifest, width, height)
    if fit:
        raise HTTPException(status_code=422, detail=f"manifest/image mismatch: {fit[0]}")

    service = _vision_service()
    if not service.available():
        raise HTTPException(status_code=503, detail="no vision provider configured: set GEMINI_API_KEY")

    outcome = await service.ground(
        goal=req.task.goal,
        intent=req.task.intent,
        image_png=png,
        width=width,
        height=height,
        regions=[r.model_dump() for r in req.redaction_manifest.regions],
    )
    total_ms = int((time.perf_counter() - start) * 1000)
    logger.info(
        "vision_step status=%s actions=%d regions=%d dims=%dx%d total_ms=%d",
        outcome.status.value,
        len(outcome.actions),
        outcome.redacted_regions,
        width,
        height,
        total_ms,
    )
    return VisionStepResponse(
        actions=outcome.actions,  # type: ignore[arg-type]
        reason=outcome.reason or "visual grounding",
        completion=outcome.completion,
        status=outcome.status,
        model=outcome.model,
        redacted_regions=outcome.redacted_regions,
    )
