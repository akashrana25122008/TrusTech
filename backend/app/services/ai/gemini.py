"""Gemini provider — PRIMARY provider.

Talks to the Google Generative Language REST API over httpx (already a
project dependency). Keys are read from the server environment only and
are sent in the ``x-goog-api-key`` header, never in the URL query string,
so they cannot leak into URL logs. Bounded transient retry (1 retry) for
429/5xx/timeouts/network; everything else fails fast into the normalized
taxonomy.
"""

from __future__ import annotations

import asyncio
import json
from urllib.parse import quote

import httpx

from backend.app.services.ai.base import AIProvider
from backend.app.services.ai.errors import (
    AIErrorCategory,
    AIServiceError,
    classify_http_status,
    classify_transport_error,
)

DEFAULT_GEMINI_MODEL = "gemini-2.5-flash"


class GeminiProvider(AIProvider):
    name = "gemini"

    ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"

    def __init__(
        self,
        api_key: str = "",
        model: str = DEFAULT_GEMINI_MODEL,
        *,
        timeout_s: float = 25.0,
        max_retries: int = 1,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self.api_key = api_key
        self._model = model or DEFAULT_GEMINI_MODEL
        self.timeout_s = timeout_s
        self.max_retries = max_retries
        self._client = client
        self._last_usage: dict = {}

    @property
    def model(self) -> str:
        return self._model

    def is_configured(self) -> bool:
        return bool(self.api_key)

    def usage(self) -> dict:
        return self._last_usage

    def __repr__(self) -> str:
        return f"<GeminiProvider model={self._model!r}>"

    async def complete(self, prompt: str) -> str:
        url = self.ENDPOINT.format(model=quote(self._model, safe=""))
        headers = {
            "x-goog-api-key": self.api_key,
            "Content-Type": "application/json",
        }
        payload = {
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {"temperature": 0.2},
        }
        owns_client = self._client is None
        client = self._client or httpx.AsyncClient(timeout=self.timeout_s)
        try:
            for attempt in range(self.max_retries + 1):
                try:
                    response = await client.post(url, headers=headers, json=payload)
                except httpx.HTTPError as exc:
                    category = classify_transport_error(exc)
                    if category is AIErrorCategory.TIMEOUT and attempt < self.max_retries:
                        await asyncio.sleep(0.4 * (2**attempt))
                        continue
                    raise AIServiceError(category, provider=self.name, message=str(exc)) from exc

                if response.status_code >= 400:
                    category = classify_http_status(self.name, response.status_code)
                    detail = self._detail(response)
                    if (
                        category
                        in (
                            AIErrorCategory.RATE_LIMIT,
                            AIErrorCategory.SERVER_ERROR,
                            AIErrorCategory.TIMEOUT,
                        )
                        and attempt < self.max_retries
                    ):
                        await asyncio.sleep(0.4 * (2**attempt))
                        continue
                    raise AIServiceError(category, provider=self.name, message=detail)

                text = self._extract_text(response)
                if text is None:
                    raise AIServiceError(
                        AIErrorCategory.MODEL_UNAVAILABLE,
                        provider=self.name,
                        message="Gemini response carried no usable text",
                    )
                return text
            raise AIServiceError(
                AIErrorCategory.UNKNOWN_ERROR,
                provider=self.name,
                message="unreachable",
            )
        finally:
            if owns_client:
                await client.aclose()

    @staticmethod
    def _detail(response: httpx.Response) -> str:
        try:
            body = response.json()
        except Exception:
            return f"HTTP {response.status_code}"
        if isinstance(body, dict):
            err = body.get("error") if isinstance(body.get("error"), dict) else None
            if isinstance(err, dict) and isinstance(err.get("message"), str):
                return err["message"]
        return f"HTTP {response.status_code}"

    def _extract_text(self, response: httpx.Response) -> str | None:
        try:
            body = response.json()
        except json.JSONDecodeError:
            return None
        if not isinstance(body, dict):
            return None
        usage = body.get("usageMetadata")
        if isinstance(usage, dict):
            self._last_usage = {
                "prompt_tokens": usage.get("promptTokenCount") or 0,
                "completion_tokens": usage.get("candidatesTokenCount") or 0,
                "total_tokens": usage.get("totalTokenCount") or 0,
            }
        candidates = body.get("candidates")
        if not isinstance(candidates, list) or not candidates:
            candidates = body.get("candidates")  # already deeper-guarded below
        for candidate in candidates:
            if not isinstance(candidate, dict):
                continue
            parts = candidate.get("content", {}).get("parts") if isinstance(candidate.get("content"), dict) else None
            if not isinstance(parts, list):
                continue
            text = "".join(
                p.get("text", "")
                for p in parts
                if isinstance(p, dict) and isinstance(p.get("text"), str)
            ).strip()
            if text:
                return text
        return None