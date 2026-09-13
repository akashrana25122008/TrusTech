"""OpenRouter provider — FINAL fallback.

Uses the OpenAI-compatible ``/api/v1/chat/completions`` endpoint. The
default model is the ``openrouter/free`` virtual endpoint, which always
resolves to a currently-available free model, so the fallback never pins
an obsolete model name; pin a concrete model (e.g.
``nvidia/nemotron-3-super-120b-a12b:free``) via ``OPENROUTER_MODEL`` if
desired. Zero internal retries to avoid burning free-tier quota.
"""

from __future__ import annotations

import httpx

from backend.app.services.ai.base import AIProvider
from backend.app.services.ai.errors import (
    AIErrorCategory,
    AIServiceError,
    classify_http_status,
    classify_transport_error,
)

DEFAULT_OPENROUTER_MODEL = "openrouter/free"

# Community-recommended attribution headers; no keys, no user data.
REFERRER = "https://trustech.local"
APP_TITLE = "TrusTech"


class OpenRouterProvider(AIProvider):
    name = "openrouter"

    ENDPOINT = "https://openrouter.ai/api/v1/chat/completions"

    def __init__(
        self,
        api_key: str = "",
        model: str = DEFAULT_OPENROUTER_MODEL,
        *,
        timeout_s: float = 25.0,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self.api_key = api_key
        self._model = model or DEFAULT_OPENROUTER_MODEL
        self.timeout_s = timeout_s
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
        return f"<OpenRouterProvider model={self._model!r}>"

    async def complete(self, prompt: str) -> str:
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "HTTP-Referer": REFERRER,
            "X-Title": APP_TITLE,
        }
        payload = {
            "model": self._model,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0.2,
            "max_tokens": 2048,
        }
        owns_client = self._client is None
        client = self._client or httpx.AsyncClient(timeout=self.timeout_s)
        try:
            try:
                response = await client.post(self.ENDPOINT, headers=headers, json=payload)
            except httpx.HTTPError as exc:
                raise AIServiceError(
                    classify_transport_error(exc),
                    provider=self.name,
                    message=str(exc),
                ) from exc

            if response.status_code >= 400:
                raise AIServiceError(
                    classify_http_status(self.name, response.status_code),
                    provider=self.name,
                    message=self._detail(response),
                )

            text = self._extract_text(response)
            if text is None:
                raise AIServiceError(
                    AIErrorCategory.MODEL_UNAVAILABLE,
                    provider=self.name,
                    message="OpenRouter response carried no usable text",
                )
            return text
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
            err = body.get("error")
            if isinstance(err, dict) and isinstance(err.get("message"), str):
                return err["message"]
            if isinstance(err, str):
                return err
        return f"HTTP {response.status_code}"

    def _extract_text(self, response: httpx.Response) -> str | None:
        try:
            body = response.json()
        except Exception:
            return None
        if not isinstance(body, dict):
            return None
        usage = body.get("usage")
        if isinstance(usage, dict):
            self._last_usage = {
                "prompt_tokens": usage.get("prompt_tokens") or 0,
                "completion_tokens": usage.get("completion_tokens") or 0,
                "total_tokens": usage.get("total_tokens") or 0,
            }
        choices = body.get("choices")
        if not isinstance(choices, list):
            return None
        for choice in choices:
            if not isinstance(choice, dict):
                continue
            message = choice.get("message")
            if isinstance(message, dict) and isinstance(message.get("content"), str):
                content = message["content"].strip()
                if content:
                    return content
        return None