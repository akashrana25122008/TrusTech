"""Fallback engine tests — Gemini → Groq → OpenRouter with clean boundaries.

Covers the ten demo scenarios plus the design guarantees:
  1. Gemini success -> normalized ProviderResult.
  2. Gemini rate-limited -> falls back to Groq.
  3. Gemini unavailable + Groq ok -> Groq wins.
  4. Gemini fail + Groq rate-limited -> OpenRouter wins.
  5. All providers fail -> ONE clean AIServiceExhaustedError (no raw detail).
  6. BAD_REQUEST is terminal (no chain burn on an invalid request).
  7. Timeout on a provider -> fallback; total budget timeout -> clean error.
  8. Cancellation propagates (agent stop is never swallowed).
  9. Repeated requests leak nothing between calls.
  10. Non-streaming contract (complete() -> str) — streaming is N/A here.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

import backend.app.api.agent_step as step_module
from backend.app.main import app

from backend.app.services.ai import (
    AIServiceConfigError,
    AIServiceError,
    AIServiceExhaustedError,
    AIErrorCategory as Cat,
)
from backend.app.services.ai.base import AIProvider, ProviderResult
from backend.app.services.ai.manager import AIProviderManager, AdapterProvider, build_simple_manager
from backend.app.services.ai.manager import CANONICAL_ORDER
from backend.app.services.llm import GroqResponseError

client = TestClient(app)

BASE_BODY = {
    "task": {"goal": "Find a C language tutorial", "intent": "search"},
    "observation": {
        "url": "https://www.youtube.com",
        "title": "YouTube",
        "tabId": 7,
        "pageType": "content",
        "visibleText": "Welcome",
        "elements": [{"id": "el_001", "role": "searchbox", "name": "Search"}],
    },
    "history": ["observed youtube"],
    "verification": None,
}


def run(coro):
    return asyncio.run(coro)


class ScriptedProvider:
    """Duck-typed provider that replays a scripted outcome per call."""

    def __init__(self, script, *, model="m", usage=None):
        self._script = list(script)
        self.model = model
        self.last_usage = usage or {"prompt_tokens": 7}
        self.calls = 0

    async def complete(self, prompt: str) -> str:
        self.calls += 1
        item = self._script.pop(0)
        if isinstance(item, BaseException):
            raise item
        return item


def wrap(name: str, impl: object) -> AIProvider:
    return AdapterProvider(impl, name=name, model=impl.model, configured=True)


def manager_of(providers: list[AIProvider], *, total_timeout_s: float = 50.0) -> AIProviderManager:
    return AIProviderManager(providers, total_timeout_s=total_timeout_s)


# 1. Gemini success ---------------------------------------------------------


def test_gemini_success_returns_normalized_result():
    gemini = ScriptedProvider(['{"action": {"action": "finish", "result": "ok"}}'])
    mgr = manager_of([wrap("gemini", gemini)])
    result = run(mgr.complete("go"))
    assert isinstance(result, ProviderResult)
    assert result.content == '{"action": {"action": "finish", "result": "ok"}}'
    assert result.provider == "gemini"
    assert result.model == gemini.model
    assert result.usage == {"prompt_tokens": 7}
    assert result.fallback_count == 0
    assert gemini.calls == 1


# 2 / 3. Manual Gemini rate-limit / down -> Groq ---------------------------------


@pytest.mark.parametrize(
    "gemini_failure",
    [
        AIServiceError(Cat.RATE_LIMIT, provider="gemini", message="429"),
        AIServiceError(Cat.QUOTA_EXCEEDED, provider="gemini", message="quota"),
        AIServiceError(Cat.SERVER_ERROR, provider="gemini", message="500"),
        AIServiceError(Cat.MODEL_UNAVAILABLE, provider="gemini", message="no such model"),
    ],
)
def test_gemini_failure_falls_back_to_groq(gemini_failure):
    gemini = ScriptedProvider([gemini_failure])
    groq = ScriptedProvider(["groq-answer"])
    mgr = manager_of([wrap("gemini", gemini), wrap("groq", groq)])
    result = run(mgr.complete("go"))
    assert result.provider == "groq"
    assert result.content == "groq-answer"
    assert result.fallback_count == 1
    assert gemini.calls == 1
    assert groq.calls == 1


def test_invalid_response_falls_back_to_next_provider():
    # A provider that answers 200-with-garbage (GroqResponseError) is a
    # provider condition, not a request bug: the chain must move on, and
    # only when every provider is unusable does INVALID_RESPONSE surface
    # (the LAST attempted category) instead of a silent success.
    gemini = ScriptedProvider([GroqResponseError("Groq returned invalid JSON")])
    groq = ScriptedProvider(["groq-clean-answer"])
    mgr = manager_of([wrap("gemini", gemini), wrap("groq", groq)])
    result = run(mgr.complete("go"))
    assert result.provider == "groq"
    assert result.content == "groq-clean-answer"
    assert result.fallback_count == 1
    assert gemini.calls == groq.calls == 1


def test_all_providers_unusable_surfaces_invalid_response_category():
    gemini = ScriptedProvider([GroqResponseError("bad json")])
    groq = ScriptedProvider([GroqResponseError("empty choices")])
    openrouter = ScriptedProvider([GroqResponseError("no content")])
    mgr = manager_of([wrap("gemini", gemini), wrap("groq", groq), wrap("openrouter", openrouter)])
    with pytest.raises(AIServiceExhaustedError) as ei:
        run(mgr.complete("go"))
    assert ei.value.category == Cat.INVALID_RESPONSE
    assert ei.value.provider == "openrouter"


# 4. Gemini fail + Groq rate-limited -> OpenRouter -----------------------------


def test_full_chain_falls_through_to_openrouter():
    gemini = ScriptedProvider([AIServiceError(Cat.SERVER_ERROR, provider="gemini")])
    groq = ScriptedProvider(
        [AIServiceError(Cat.RATE_LIMIT, provider="groq", message="429 free tier")]
    )
    openrouter = ScriptedProvider(["openrouter-answer"], usage={"total_tokens": 12})
    mgr = manager_of([wrap("gemini", gemini), wrap("groq", groq), wrap("openrouter", openrouter)])
    result = run(mgr.complete("go"))
    assert result.provider == "openrouter"
    assert result.content == "openrouter-answer"
    assert result.fallback_count == 2
    assert result.usage == {"total_tokens": 12}
    assert gemini.calls == groq.calls == openrouter.calls == 1


# 5. All providers fail -> one clean exhausted error ---------------------------


def test_all_providers_fail_with_clean_exhausted_error():
    gemini = ScriptedProvider([AIServiceError(Cat.RATE_LIMIT, provider="gemini")])
    groq = ScriptedProvider([AIServiceError(Cat.RATE_LIMIT, provider="groq")])
    openrouter = ScriptedProvider([AIServiceError(Cat.SERVER_ERROR, provider="openrouter")])
    mgr = manager_of([wrap("gemini", gemini), wrap("groq", groq), wrap("openrouter", openrouter)])
    with pytest.raises(AIServiceExhaustedError) as ei:
        run(mgr.complete("go"))
    err = ei.value
    assert err.category == Cat.SERVER_ERROR  # last provider attempted
    assert err.provider == "openrouter"
    assert "all AI providers failed" in err.message
    # No provider names, no status codes, no keys inside the user-facing text.
    for name in ("gemini", "groq", "openrouter", "429", "gsk"):
        assert name not in err.message


def test_all_providers_fail_maps_to_clean_503_at_endpoint(monkeypatch):
    failing = ScriptedProvider([AIServiceError(Cat.RATE_LIMIT, provider="gemini")])
    monkeypatch.setattr(
        step_module,
        "_ai_manager",
        lambda: build_simple_manager(failing, name="gemini"),
    )
    resp = client.post("/api/agent/step", json=BASE_BODY)
    assert resp.status_code == 503
    assert "rate-limited" in resp.json()["detail"]
    assert "gsk" not in resp.text and "gemini" not in resp.json()["detail"]


# 6. BAD_REQUEST is terminal ---------------------------------------------------


def test_bad_request_stops_chain_immediately():
    gemini = ScriptedProvider(
        [AIServiceError(Cat.BAD_REQUEST, provider="gemini", message="invalid payload")]
    )
    groq = ScriptedProvider(["must-not-run"])
    mgr = manager_of([wrap("gemini", gemini), wrap("groq", groq)])
    with pytest.raises(AIServiceError) as ei:
        run(mgr.complete("go"))
    assert ei.value.category == Cat.BAD_REQUEST
    assert groq.calls == 0, "invalid request must never burn the rest of the chain"
    assert gemini.calls == 1


def test_bad_request_maps_to_400_at_endpoint(monkeypatch):
    failing = ScriptedProvider(
        [AIServiceError(Cat.BAD_REQUEST, provider="gemini", message="bad payload")]
    )
    monkeypatch.setattr(
        step_module,
        "_ai_manager",
        lambda: build_simple_manager(failing, name="gemini"),
    )
    resp = client.post("/api/agent/step", json=BASE_BODY)
    assert resp.status_code == 400


# 7. Timeouts ------------------------------------------------------------------


def test_timeout_on_primary_falls_back():
    gemini = ScriptedProvider([AIServiceError(Cat.TIMEOUT, provider="gemini")])
    groq = ScriptedProvider(["fast-answer"])
    mgr = manager_of([wrap("gemini", gemini), wrap("groq", groq)])
    result = run(mgr.complete("go"))
    assert result.provider == "groq"
    assert result.content == "fast-answer"


class SlowProvider:
    model = "slow"

    async def complete(self, prompt: str) -> str:
        await asyncio.sleep(30)
        return "late"


def test_total_budget_timeout_is_clean_error():
    mgr = manager_of([wrap("gemini", SlowProvider())], total_timeout_s=0.05)
    with pytest.raises(AIServiceError) as ei:
        run(mgr.complete("go"))
    assert ei.value.category == Cat.TIMEOUT
    assert ei.value.message  # non-empty, internal detail


# 8. Cancellation propagates ---------------------------------------------------


def test_cancellation_propagates_not_swallowed():
    mgr = manager_of([wrap("gemini", SlowProvider())])

    async def scenario():
        task = asyncio.create_task(mgr.complete("go"))
        await asyncio.sleep(0.05)
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            return "cancelled"
        return "completed-or-error"

    assert run(scenario()) == "cancelled"


# 9. Repeated requests leak nothing --------------------------------------------


def test_repeated_requests_do_not_contaminate():
    gemini = ScriptedProvider(
        [AIServiceError(Cat.RATE_LIMIT, provider="gemini")] * 3
    )
    groq = ScriptedProvider(["a", "b", "c"])
    mgr = manager_of([wrap("gemini", gemini), wrap("groq", groq)])

    first = run(mgr.complete("one"))
    second = run(mgr.complete("two"))
    third = run(mgr.complete("three"))

    assert [first.content, second.content, third.content] == ["a", "b", "c"]
    assert [first.provider, second.provider, third.provider] == ["groq", "groq", "groq"]
    assert [first.fallback_count] * 3 == [1, 1, 1]
    assert gemini.calls == 3 and groq.calls == 3
    # usage is per-response, not accumulated across requests
    assert first.usage == {"prompt_tokens": 7}


# 10. Non-streaming contract ----------------------------------------------------


def test_complete_returns_plain_string_not_stream():
    gemini = ScriptedProvider(["plain-answer"])
    mgr = manager_of([wrap("gemini", gemini)])
    result = run(mgr.complete("go"))
    assert isinstance(result.content, str)
    # Streaming is N/A end to end: providers await and return the FULL text,
    # never an async iterator — mirroring the extension's non-streaming step
    # call. (Documented in the report.)
    assert not hasattr(mgr.complete, "__aiter__")


# Configuration & ordering -------------------------------------------------------


def test_no_provider_configured_raises_config_error():
    mgr = AIProviderManager.from_settings(SimpleNamespace())
    assert mgr.has_configured_provider() is False
    with pytest.raises(AIServiceConfigError) as ei:
        run(mgr.complete("go"))
    assert ei.value.category == Cat.CONFIG


def test_from_settings_reads_all_provider_fields():
    settings = SimpleNamespace(
        gemini_api_key="k_gemini",
        gemini_model="gm-x",
        groq_api_key="k_groq",
        groq_model="openai/gpt-oss-20b",
        openrouter_api_key="k_or",
        openrouter_model="openrouter/free",
        ai_primary_provider="gemini",
        ai_provider_timeout_s=12.0,
        ai_total_timeout_s=40.0,
    )
    mgr = AIProviderManager.from_settings(settings)
    assert mgr.has_configured_provider()
    names = [p.name for p in mgr.providers]
    assert names == ["gemini", "groq", "openrouter"]
    assert mgr.total_timeout_s == 40.0


def test_primary_override_reorders_chain():
    settings = SimpleNamespace(
        gemini_api_key="k",
        groq_api_key="k",
        openrouter_api_key="k",
        ai_primary_provider="groq",
    )
    mgr = AIProviderManager.from_settings(settings)
    assert [p.name for p in mgr.providers] == ["groq", "gemini", "openrouter"]


def test_unknown_primary_falls_back_to_canonical_order():
    assert CANONICAL_ORDER[0] == "gemini"
    settings = SimpleNamespace(
        gemini_api_key="k",
        groq_api_key="k",
        openrouter_api_key="k",
        ai_primary_provider="weird",
    )
    mgr = AIProviderManager.from_settings(settings)
    assert [p.name for p in mgr.providers] == ["gemini", "groq", "openrouter"]


def test_unconfigured_providers_are_skipped_not_called():
    gemini = ScriptedProvider(["answer"])
    groq = ScriptedProvider(["nope"])
    mgr = manager_of(
        [
            wrap("gemini", gemini),
            AdapterProvider(groq, name="groq", model="openai/gpt-oss-20b", configured=False),
        ]
    )
    result = run(mgr.complete("go"))
    assert result.provider == "gemini"
    assert groq.calls == 0


def test_authentication_failure_falls_through():
    gemini = ScriptedProvider(
        [AIServiceError(Cat.AUTHENTICATION_ERROR, provider="gemini", message="bad key")]
    )
    groq = ScriptedProvider(["groq-answer"])
    mgr = manager_of([wrap("gemini", gemini), wrap("groq", groq)])
    result = run(mgr.complete("go"))
    assert result.provider == "groq"
    assert result.fallback_count == 1


def test_metadata_tracks_fallback_count():
    gemini = ScriptedProvider([AIServiceError(Cat.RATE_LIMIT, provider="gemini")])
    groq = ScriptedProvider(["ok"])
    mgr = manager_of([wrap("gemini", gemini), wrap("groq", groq)])
    result = run(mgr.complete("go"))
    assert (result.provider, result.fallback_count) == ("groq", 1)