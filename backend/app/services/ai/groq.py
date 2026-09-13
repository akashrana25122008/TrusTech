"""Groq provider — SECONDARY fallback.

This is an ADAPTER over the existing, already-tested ``GroqLlmProvider``
transport (``backend/app/services/llm.py``) — no browser/HTTP logic is
duplicated. It only maps the legacy Groq error classes onto the normalized
taxonomy so the fallback engine can treat Groq uniformly with a single
interface. Groq's own bounded retry (transient 429/5xx/timeout, with
backoff) is preserved.
"""

from __future__ import annotations

import httpx

from backend.app.services.ai.base import AIProvider
from backend.app.services.ai.errors import map_to_ai_error
from backend.app.services.llm import GroqLlmProvider


class GroqProvider(AIProvider):
    name = "groq"

    def __init__(
        self,
        api_key: str = "",
        model: str = "openai/gpt-oss-20b",
        *,
        timeout_s: float = 25.0,
        max_retries: int = 1,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self._model = model or "openai/gpt-oss-20b"
        # GroqLlmProvider raises GroqConfigError on an empty key, so we only
        # construct it when a key is present; an unconfigured GroqProvider is
        # a cheap skip-able placeholder for the manager chain.
        self._impl = (
            GroqLlmProvider(
                api_key=api_key,
                model=self._model,
                timeout_s=timeout_s,
                max_retries=max_retries,
                client=client,
            )
            if api_key
            else None
        )

    @property
    def model(self) -> str:
        return self._model

    def is_configured(self) -> bool:
        return self._impl is not None

    def usage(self) -> dict:
        return dict(getattr(self._impl, "last_usage", None) or {})

    def __repr__(self) -> str:
        return f"<GroqProvider model={self._model!r} configured={self.is_configured()}>"

    async def complete(self, prompt: str) -> str:
        if self._impl is None:
            from backend.app.services.ai.errors import AIErrorCategory, AIServiceError

            raise AIServiceError(
                AIErrorCategory.CONFIG,
                provider=self.name,
                message="Groq not configured",
            )
        try:
            return await self._impl.complete(prompt)
        except Exception as exc:  # noqa: BLE001 - mapped (kept CancelledError intact)
            raise map_to_ai_error(exc, provider=self.name) from exc