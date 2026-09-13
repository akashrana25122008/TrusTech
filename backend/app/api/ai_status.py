"""Provider configuration/health probe (Phase 19).

GET /api/ai/status — reports the provider chain (order), the selected
models and which providers are configured, so an operator/judge can see
at a glance whether Gemini/Groq/OpenRouter are wired up. Never returns or
even hints at credential material; unconfigured optional providers are
reported as such instead of failing startup.
"""

from __future__ import annotations

from fastapi import APIRouter

from backend.app.services.ai.manager import AIProviderManager
from backend.app.services.config import get_settings

router = APIRouter(tags=["ai"])


@router.get("/api/ai/status")
def ai_status() -> dict:
    manager = AIProviderManager.from_settings(get_settings())
    return {
        "status": "ok" if manager.has_configured_provider() else "no_provider_configured",
        **manager.provider_status(),
    }