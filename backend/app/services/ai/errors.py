"""Normalized error taxonomy for the multi-provider AI fallback engine.

The ONLY thing the agent bridge (``agent_step``) sees is an
``AIServiceError`` carrying one ``AIErrorCategory``. Provider internals
(HTTP statuses, provider error strings, API keys) never leave this layer
except as internal log lines.

Groq rate-limit / quota exhaustion is an EXTERNAL provider constraint:
it is classified and used to trigger fallback (Gemini → Groq →
OpenRouter), never treated as an application bug. Project-side handling
of it is what this module expresses.
"""

from __future__ import annotations

import asyncio
from enum import Enum

import httpx

from backend.app.services.llm import (
    GroqAuthError,
    GroqConfigError,
    GroqRateLimitError,
    GroqResponseError,
    GroqServerError,
    GroqTimeoutError,
)


class AIErrorCategory(str, Enum):
    RATE_LIMIT = "RATE_LIMIT"
    QUOTA_EXCEEDED = "QUOTA_EXCEEDED"
    TIMEOUT = "TIMEOUT"
    AUTHENTICATION_ERROR = "AUTHENTICATION_ERROR"
    BAD_REQUEST = "BAD_REQUEST"
    SERVER_ERROR = "SERVER_ERROR"
    NETWORK_ERROR = "NETWORK_ERROR"
    MODEL_UNAVAILABLE = "MODEL_UNAVAILABLE"
    INVALID_RESPONSE = "INVALID_RESPONSE"
    CONFIG = "CONFIG"
    UNKNOWN_ERROR = "UNKNOWN_ERROR"


def is_fallback_eligible(category: AIErrorCategory) -> bool:
    """Whether a failure should move on to the next provider.

    Rate limits, quota exhaustion, timeouts, 5xx, network problems and a
    provider turning out to answer unusably are all transient *provider*
    conditions → jumping to the next provider is safe and desirable.

    A BAD_REQUEST (invalid user request rejected by the provider) is a
    *request* condition that would recur on every provider, so it is the
    only category that stops the chain immediately.
    """
    return category not in (
        AIErrorCategory.BAD_REQUEST,
    )


class AIServiceError(Exception):
    """NORMALIZED provider/chain failure. Safe for the bridge to map to an
    HTTP status; the `message` is internal detail (logged), never user text."""

    def __init__(
        self,
        category: AIErrorCategory,
        *,
        provider: str | None = None,
        message: str = "",
    ) -> None:
        self.category = category
        self.provider = provider
        self.message = message
        super().__init__(message or f"{provider or 'ai'}: {category.value}")

    @property
    def triggers_fallback(self) -> bool:
        return is_fallback_eligible(self.category)


class AIServiceConfigError(AIServiceError):
    """No usable provider is configured (all API keys missing)."""


class AIServiceExhaustedError(AIServiceError):
    """Every configured provider failed with fallback-eligible errors.

    Raises the category of the LAST provider attempted so callers can tell
    the user the AI service is unavailable without exposing provider names
    or raw provider error text.
    """


def classify_http_status(provider: str, status: int) -> AIErrorCategory:
    """Map a provider HTTP status onto the normalized taxonomy."""
    if status == 400:
        return AIErrorCategory.BAD_REQUEST
    if status in (401, 403):
        return AIErrorCategory.AUTHENTICATION_ERROR
    if status in (402,):
        return AIErrorCategory.QUOTA_EXCEEDED
    if status in (404, 410):
        return AIErrorCategory.MODEL_UNAVAILABLE
    if status in (408, 425):
        return AIErrorCategory.TIMEOUT
    if status in (429, 409):
        return AIErrorCategory.RATE_LIMIT
    if 500 <= status <= 599:
        return AIErrorCategory.SERVER_ERROR
    return AIErrorCategory.UNKNOWN_ERROR


def classify_transport_error(exc: BaseException) -> AIErrorCategory:
    """Map an httpx transport failure onto the normalized taxonomy."""
    if isinstance(exc, (httpx.TimeoutException, asyncio.TimeoutError)):
        return AIErrorCategory.TIMEOUT
    if isinstance(exc, httpx.HTTPError):
        return AIErrorCategory.NETWORK_ERROR
    return AIErrorCategory.UNKNOWN_ERROR


def map_to_ai_error(
    exc: BaseException,
    *,
    provider: str,
    message: str = "",
) -> AIServiceError:
    """Translate ANY raised error — normalized, legacy Groq, or httpx —
    into an ``AIServiceError`` with the right category. Used by the manager
    so duck-typed providers and the legacy Groq transport fit one contract.

    ``asyncio.CancelledError`` is re-raised unchanged (cancellation must
    travel through the chain untouched so agent stops work).
    """
    if isinstance(exc, asyncio.CancelledError):
        raise exc
    if isinstance(exc, AIServiceError):
        return exc
    if isinstance(exc, GroqRateLimitError):
        return AIServiceError(AIErrorCategory.RATE_LIMIT, provider=provider, message=message or str(exc))
    if isinstance(exc, GroqTimeoutError):
        return AIServiceError(AIErrorCategory.TIMEOUT, provider=provider, message=message or str(exc))
    if isinstance(exc, GroqAuthError):
        return AIServiceError(AIErrorCategory.AUTHENTICATION_ERROR, provider=provider, message=message or str(exc))
    if isinstance(exc, GroqConfigError):
        return AIServiceError(AIErrorCategory.CONFIG, provider=provider, message=message or str(exc))
    if isinstance(exc, GroqResponseError):
        # A 200-with-garbage body means the model answered unusably — the
        # reason to leave this provider and try another — not a request bug.
        return AIServiceError(AIErrorCategory.INVALID_RESPONSE, provider=provider, message=message or str(exc))
    if isinstance(exc, GroqServerError):
        category = (
            AIErrorCategory.NETWORK_ERROR
            if "transport failure" in str(exc)
            else AIErrorCategory.SERVER_ERROR
        )
        return AIServiceError(category, provider=provider, message=message or str(exc))
    if isinstance(exc, (httpx.TimeoutException, asyncio.TimeoutError)):
        return AIServiceError(AIErrorCategory.TIMEOUT, provider=provider, message=message or str(exc))
    if isinstance(exc, httpx.HTTPError):
        return AIServiceError(AIErrorCategory.NETWORK_ERROR, provider=provider, message=message or str(exc))
    return AIServiceError(
        AIErrorCategory.UNKNOWN_ERROR,
        provider=provider,
        message=message or f"{type(exc).__name__}: {exc}",
    )