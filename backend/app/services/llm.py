"""LLM gateway — single provider interface for planning/verification."""

import asyncio
from abc import ABC, abstractmethod

import httpx


class LLMProvider(ABC):
    @abstractmethod
    async def complete(self, prompt: str) -> str:
        raise NotImplementedError


class PlaceholderLLM(LLMProvider):
    async def complete(self, prompt: str) -> str:
        return "simulated-planning-result"


class GroqError(Exception):
    """Base for all Groq gateway failures."""


class GroqConfigError(GroqError, ValueError):
    """Missing/empty API key — fail fast, never retry."""


class GroqAuthError(GroqError):
    """401/403 — key invalid or revoked. Never retry."""


class GroqRateLimitError(GroqError):
    """429 — retried with backoff, then surfaced."""


class GroqTimeoutError(GroqError):
    """Connect/read timeout — retried, then surfaced."""


class GroqServerError(GroqError):
    """5xx / network failure — retried, then surfaced."""


class GroqResponseError(GroqError):
    """200 with unusable body (bad JSON, empty choices). Never retry."""


class GroqLlmProvider(LLMProvider):
    """Groq chat-completions provider behind the LLMProvider abstraction.

    Uses the OpenAI-compatible endpoint so the model stays configurable
    (``openai/gpt-oss-20b`` today, ``openai/gpt-oss-120b`` later) via
    ``GROQ_MODEL`` with zero code changes. Retries 429/5xx/timeouts with
    bounded exponential backoff; 401/403 and malformed bodies fail fast.
    """

    ENDPOINT = "https://api.groq.com/openai/v1/chat/completions"

    def __init__(
        self,
        api_key: str = "",
        model: str = "openai/gpt-oss-20b",
        timeout_s: float = 30.0,
        max_retries: int = 2,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        if not api_key:
            raise GroqConfigError("GROQ_API_KEY is not configured")
        self.api_key = api_key
        self.model = model
        self.timeout_s = timeout_s
        self.max_retries = max_retries
        self._client = client
        self._owns_client = client is None
        # Last response usage block (prompt/completion tokens) when the API
        # returns one; read by the gateway for telemetry. Never secrets.
        self.last_usage: dict = {}

    def __repr__(self) -> str:
        return f"<GroqLlmProvider model={self.model!r}>"

    async def complete(self, prompt: str) -> str:
        payload = {
            "model": self.model,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0.2,
        }
        last_error: GroqError = GroqServerError("unreachable")
        for attempt in range(self.max_retries + 1):
            try:
                return await self._request_once(payload)
            except GroqRateLimitError as e:
                last_error = e
            except (GroqServerError, GroqTimeoutError) as e:
                last_error = e
            if attempt < self.max_retries:
                await asyncio.sleep(0.2 * (2**attempt))
        raise last_error

    async def _request_once(self, payload: dict) -> str:
        client = self._client or httpx.AsyncClient(timeout=self.timeout_s)
        try:
            try:
                response = await client.post(
                    self.ENDPOINT,
                    headers={"Authorization": f"Bearer {self.api_key}"},
                    json=payload,
                )
            except httpx.TimeoutException as e:
                raise GroqTimeoutError(f"Groq request timed out: {e}") from e
            except httpx.HTTPError as e:
                raise GroqServerError(f"Groq transport failure: {e}") from e

            if response.status_code in (401, 403):
                raise GroqAuthError(f"Groq rejected the API key (HTTP {response.status_code})")
            if response.status_code == 429:
                raise GroqRateLimitError("Groq rate limit exceeded (HTTP 429)")
            if response.status_code >= 500:
                raise GroqServerError(f"Groq server error (HTTP {response.status_code})")
            if response.status_code != 200:
                raise GroqResponseError(f"Unexpected Groq status (HTTP {response.status_code})")

            try:
                body = response.json()
            except ValueError as e:
                raise GroqResponseError("Groq returned invalid JSON") from e
            choices = body.get("choices") if isinstance(body, dict) else None
            content = choices[0].get("message", {}).get("content") if choices else None
            if not content or not isinstance(content, str):
                raise GroqResponseError("Groq response carried no message content")
            usage = body.get("usage")
            self.last_usage = dict(usage) if isinstance(usage, dict) else {}
            return content
        finally:
            if self._owns_client:
                await client.aclose()