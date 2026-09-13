"""Provider abstraction — the ONE interface TrusTech talks to.

Every AI provider (Gemini, Groq, OpenRouter) implements ``AIProvider`` and
produces/provider traits through a plain ``ProviderResult``. The rest of the
backend never sees provider-specific response shapes; the provider manager
decides which provider runs and normalizes the outcome.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field


@dataclass(slots=True)
class ProviderResult:
    """Normalized, provider-agnostic completion outcome."""

    content: str
    provider: str
    model: str
    usage: dict = field(default_factory=dict)
    latency_ms: int = 0
    fallback_count: int = 0


class AIProvider(ABC):
    """Contract every provider adapter implements.

    ``complete`` raises ``AIServiceError`` (normalized category) on
    failure; providers keep their own bounded transient retry policy and
    their own timeout. ``is_configured`` reports whether an API key (and
    model) are present so the manager can skip the provider cheaply.
    """

    name: str = "unknown"

    @property
    @abstractmethod
    def model(self) -> str:
        raise NotImplementedError

    def is_configured(self) -> bool:
        raise NotImplementedError

    @abstractmethod
    async def complete(self, prompt: str) -> str:
        raise NotImplementedError

    def usage(self) -> dict:
        """Optional usage/token telemetry from the last completion."""
        return {}