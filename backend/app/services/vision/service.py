from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Any

from backend.app.schemas.vision_step import VisionStatus
from backend.app.services.ai.errors import AIServiceError, AIErrorCategory
from backend.app.services.vision.grounding import authorize_actions, normalize_actions, parse_model_json
from backend.app.services.vision.prompt import build_vision_prompt
from backend.app.services.vision.provider import VisionModelProvider

logger = logging.getLogger("trustech.vision_step")


@dataclass(slots=True)
class VisionOutcome:
    status: VisionStatus
    actions: list[dict[str, Any]] = field(default_factory=list)
    reason: str = ""
    completion: bool = False
    model: str = ""
    provider: str = ""
    redacted_regions: int = 0
    vision_latency_ms: int = 0


class VisionService:
    def __init__(self, provider: VisionModelProvider | None, *, model_timeout_s: float = 30.0) -> None:
        self.provider = provider
        self.model_timeout_s = max(1.0, float(model_timeout_s))

    def available(self) -> bool:
        return self.provider is not None and self.provider.is_configured()

    async def ground(
        self,
        *,
        goal: str,
        intent: str | None,
        image_png: bytes,
        width: int,
        height: int,
        regions: list[dict[str, Any]],
    ) -> VisionOutcome:
        if not self.available():
            return VisionOutcome(status=VisionStatus.ERROR, reason="no vision provider configured")
        prompt = build_vision_prompt(goal, intent, width, height, regions)
        assert self.provider is not None
        try:
            result = await asyncio.wait_for(
                self.provider.analyze_image(prompt, image_png), timeout=self.model_timeout_s
            )
        except (asyncio.TimeoutError, TimeoutError):
            logger.error("[vision] provider timed out after %.0fs", self.model_timeout_s)
            return VisionOutcome(status=VisionStatus.ERROR, reason="vision provider timed out")
        except AIServiceError as err:
            logger.error("[vision] provider=%s category=%s", err.provider or "-", err.category.value)
            return VisionOutcome(status=VisionStatus.ERROR, reason=f"vision provider failed: {err.category.value}")
        try:
            parsed = parse_model_json(result.content)
            actions, reason, completion = normalize_actions(parsed, width, height)
        except ValueError as exc:
            logger.error("[vision] unusable model output: %s", str(exc)[:160])
            return VisionOutcome(
                status=VisionStatus.INVALID_MODEL_OUTPUT,
                reason="model returned unusable grounding output",
                model=result.model,
                provider=result.provider,
                redacted_regions=len(regions),
                vision_latency_ms=result.latency_ms,
            )
        allowed, verdict = authorize_actions(actions, regions)
        status = {
            "success": VisionStatus.SUCCESS,
            "low_confidence": VisionStatus.LOW_CONFIDENCE,
            "blocked_by_privacy": VisionStatus.BLOCKED_BY_PRIVACY,
        }[verdict]
        if verdict != "success":
            reason = {"low_confidence": "target confidence below execution threshold", "blocked_by_privacy": "target overlaps a protected sensitive region"}[verdict]
        if not allowed and verdict == "success":
            status, reason = VisionStatus.TARGET_NOT_FOUND, "no visual target identified"
        return VisionOutcome(
            status=status,
            actions=allowed,
            reason=reason[:300],
            completion=completion and bool(allowed),
            model=result.model,
            provider=result.provider,
            redacted_regions=len(regions),
            vision_latency_ms=result.latency_ms,
        )
