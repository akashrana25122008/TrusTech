"""AIProviderManager — the centralized fallback engine.

Single place TrusTech asks for a completion. Provider-priority is
configurable via ``AI_PRIMARY_PROVIDER`` (default ``gemini``); the chain is
always Gemini → Groq → OpenRouter relative order with the configured primary
moved to the front.

Fallback policy:
  * Providers without an API key are skipped (logged), never called.
  * Each configured provider is attempted exactly ONCE (internal per-provider
    transient retries are bounded and owned by the provider).
  * A failure whose category is fallback-eligible (rate limit, quota, timeout,
    5xx, network, unusable model output, unknown) moves to the next provider.
  * A BAD_REQUEST stops the chain immediately (it would recur on every
    provider — never burn the rest of the chain on an invalid request).
  * The whole chain runs under one total-timeout budget, so the bridge can
    NEVER be left hanging even if every provider stalls.
  * All-providers-failed surfaces ONE normalized ``AIServiceError`` — no raw
    provider details, no API keys, no stack traces.

Cancellation (agent stop) propagates untouched: ``asyncio.CancelledError``
is re-raised through the chain so the extension's abort works.
"""

from __future__ import annotations

import asyncio
import logging
import time

from backend.app.services.ai.base import AIProvider, ProviderResult
from backend.app.services.ai.errors import (
    AIErrorCategory,
    AIServiceConfigError,
    AIServiceError,
    AIServiceExhaustedError,
    map_to_ai_error,
)
from backend.app.services.ai.gemini import DEFAULT_GEMINI_MODEL, GeminiProvider
from backend.app.services.ai.groq import GroqProvider
from backend.app.services.ai.openrouter import DEFAULT_OPENROUTER_MODEL, OpenRouterProvider

logger = logging.getLogger("trustech.ai")

CANONICAL_ORDER = ("gemini", "groq", "openrouter")
DEFAULT_GROQ_MODEL = "openai/gpt-oss-20b"


def _get(settings: object, name: str, default: object) -> object:
    try:
        value = getattr(settings, name)
    except Exception:  # noqa: BLE001 - settings seam may be a SimpleNamespace
        return default
    return default if value in (None, "") else value


class AIProviderManager:
    def __init__(
        self,
        providers: list[AIProvider],
        *,
        total_timeout_s: float = 50.0,
    ) -> None:
        # Keep only distinct providers, canonical iteration stable.
        seen: set[str] = set()
        self.providers: list[AIProvider] = []
        for provider in providers:
            if provider.name in seen:
                continue
            seen.add(provider.name)
            self.providers.append(provider)
        self.total_timeout_s = max(1.0, float(total_timeout_s))

    # ---- construction -------------------------------------------------

    @classmethod
    def from_settings(cls, settings: object) -> "AIProviderManager":
        """Build the provider chain from a settings object (pydantic Settings
        in production, any namespace in tests). Attributes are read
        tolerantly so a partial environment never crashes construction."""

        def val(name: str, default: object) -> object:
            return _get(settings, name, default)

        gemini = GeminiProvider(
            api_key=str(val("gemini_api_key", "")),
            model=str(val("gemini_model", DEFAULT_GEMINI_MODEL)),
            timeout_s=float(val("ai_provider_timeout_s", 25.0)),
        )
        groq = GroqProvider(
            api_key=str(val("groq_api_key", "")),
            model=str(val("groq_model", DEFAULT_GROQ_MODEL)),
            timeout_s=float(val("ai_provider_timeout_s", 25.0)),
        )
        openrouter = OpenRouterProvider(
            api_key=str(val("openrouter_api_key", "")),
            model=str(val("openrouter_model", DEFAULT_OPENROUTER_MODEL)),
            timeout_s=float(val("ai_provider_timeout_s", 25.0)),
        )
        primary = str(val("ai_primary_provider", "gemini")).strip().lower() or "gemini"
        providers = cls.order_providers(
            [gemini, groq, openrouter],
            primary=primary,
        )
        total = float(val("ai_total_timeout_s", 50.0))
        return cls(providers, total_timeout_s=total)

    @classmethod
    def order_providers(
        cls,
        providers: list[AIProvider],
        *,
        primary: str,
    ) -> list[AIProvider]:
        """Return providers ordered primary-first, canonical relative order
        afterwards. Unknown primary names fall back to canonical order."""
        by_name = {provider.name: provider for provider in providers}
        if primary not in (by_name):
            return [by_name[name] for name in CANONICAL_ORDER if name in by_name]
        rest = [name for name in CANONICAL_ORDER if name != primary and name in by_name]
        return [by_name[primary], *(by_name[name] for name in rest)]

    # ---- public API ----------------------------------------------------

    def has_configured_provider(self) -> bool:
        return any(provider.is_configured() for provider in self.providers)

    def provider_chain(self) -> list[tuple[str, str, bool]]:
        """Debug aid: (name, model, configured) for each provider in order."""
        return [(p.name, p.model, p.is_configured()) for p in self.providers]

    def provider_status(self) -> dict:
        """Lightweight configuration probe (Phase 19). Never emits keys.

        Shape: {"providers": [{name, model, configured}], "configured": [...],
        "primary": name}. Unconfigured optional providers are reported, not
        hidden — the chain simply skips them at request time.
        """
        primary = self.providers[0].name if self.providers else None
        return {
            "providers": [
                {"name": p.name, "model": p.model, "configured": p.is_configured()}
                for p in self.providers
            ],
            "configured": [p.name for p in self.providers if p.is_configured()],
            "primary": primary,
        }

    async def complete(self, prompt: str) -> ProviderResult:
        if not self.has_configured_provider():
            raise AIServiceConfigError(
                AIErrorCategory.CONFIG,
                provider=None,
                message="no AI provider configured (no API keys present)",
            )
        try:
            return await asyncio.wait_for(
                self._complete(prompt),
                timeout=self.total_timeout_s,
            )
        except (asyncio.TimeoutError, TimeoutError):
            logger.error("[AI] chain exceeded total budget (%.0fs)", self.total_timeout_s)
            raise AIServiceError(
                AIErrorCategory.TIMEOUT,
                provider=None,
                message="AI provider chain exceeded total timeout",
            ) from None

    async def _complete(self, prompt: str) -> ProviderResult:
        failures: list[AIServiceError] = []
        attempts = 0

        for provider in self.providers:
            if not provider.is_configured():
                logger.info("[AI] provider=%s skipped (not configured)", provider.name)
                continue

            attempts += 1
            logger.info(
                "[AI] Attempting provider=%s model=%s",
                provider.name,
                provider.model,
            )

            started = time.perf_counter()
            try:
                content = await provider.complete(prompt)
            except asyncio.CancelledError:
                logger.info("[AI] cancelled during provider=%s", provider.name)
                raise
            except Exception as exc:  # noqa: BLE001 - normalized centrally
                mapped = map_to_ai_error(exc, provider=provider.name)
                latency_ms = int((time.perf_counter() - started) * 1000)
                failures.append(mapped)
                if not mapped.triggers_fallback:
                    logger.warning(
                        "[AI] provider=%s terminal failure category=%s (%dms) — chain stopped",
                        provider.name,
                        mapped.category.value,
                        latency_ms,
                    )
                    raise mapped
                logger.warning(
                    "[AI] provider=%s failed category=%s (%dms) -> trying next provider",
                    provider.name,
                    mapped.category.value,
                    latency_ms,
                )
                continue

            latency_ms = int((time.perf_counter() - started) * 1000)
            logger.info(
                "[AI] provider=%s ok (%dms)",
                provider.name,
                latency_ms,
            )
            return ProviderResult(
                content=content,
                provider=provider.name,
                model=provider.model,
                usage=dict(provider.usage() or {}),
                latency_ms=latency_ms,
                fallback_count=attempts - 1,
            )

        last = failures[-1] if failures else None
        category = last.category if last else AIErrorCategory.UNKNOWN_ERROR
        logger.error(
            "[AI] all providers failed (%d attempted); last category=%s",
            len(failures),
            category.value,
        )
        raise AIServiceExhaustedError(
            category=category,
            provider=last.provider if last else None,
            message="all AI providers failed",
        )


def build_simple_manager(
    impl: object,
    *,
    name: str = "fake",
    model: str = "openai/gpt-oss-20b",
    configured: bool = True,
    total_timeout_s: float = 50.0,
) -> AIProviderManager:
    """Test seam: wrap a duck-typed ``async complete(prompt) -> str`` object
    (with optional ``last_usage``) so existing endpoint tests exercise the
    real fallback-manager path without making any HTTP call."""
    return AIProviderManager(
        [AdapterProvider(impl, name=name, model=model, configured=configured)],
        total_timeout_s=total_timeout_s,
    )


class AdapterProvider(AIProvider):
    """Duck-typed provider adapter used by the test seam."""

    def __init__(self, impl: object, *, name: str, model: str, configured: bool) -> None:
        self._impl = impl
        self.name = name
        self._model = model
        self._configured = configured

    @property
    def model(self) -> str:
        return self._model

    def is_configured(self) -> bool:
        return self._configured and callable(getattr(self._impl, "complete", None))

    def usage(self) -> dict:
        return dict(getattr(self._impl, "last_usage", None) or {})

    def __repr__(self) -> str:
        return f"<AdapterProvider name={self.name!r} model={self._model!r}>"

    async def complete(self, prompt: str) -> str:
        return await self._impl.complete(prompt)  # type: ignore[misc]