"""Phase 1/18A — GroqLlmProvider: key handling, transport errors, retries."""

import asyncio
import json

import httpx
import pytest

from backend.app.services.config import Settings
from backend.app.services.llm import (
    GroqAuthError,
    GroqConfigError,
    GroqLlmProvider,
    GroqRateLimitError,
    GroqResponseError,
    GroqServerError,
    GroqTimeoutError,
)

KEY = "gsk_test_key"
MODEL = "openai/gpt-oss-20b"


def run(coro):
    return asyncio.run(coro)


def client_for(handler, calls: list):
    def wrapped(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return handler(request)

    return httpx.AsyncClient(transport=httpx.MockTransport(wrapped))


def ok_response(content: str = '{"action":"finish"}') -> httpx.Response:
    return httpx.Response(200, json={"choices": [{"message": {"content": content}}]})


def test_missing_key_fails_fast():
    with pytest.raises(GroqConfigError):
        GroqLlmProvider(api_key="")


def test_valid_request_returns_content_and_sends_key_and_model():
    calls: list = []
    client = client_for(lambda req: ok_response(), calls)
    provider = GroqLlmProvider(api_key=KEY, model=MODEL, client=client)
    assert run(provider.complete("hello")) == '{"action":"finish"}'
    assert len(calls) == 1
    assert calls[0].headers["authorization"] == f"Bearer {KEY}"
    assert json.loads(calls[0].content)["model"] == MODEL


def test_malformed_json_body_is_not_retried():
    calls: list = []
    client = client_for(lambda req: httpx.Response(200, content=b"not-json{"), calls)
    provider = GroqLlmProvider(api_key=KEY, client=client)
    with pytest.raises(GroqResponseError):
        run(provider.complete("hello"))
    assert len(calls) == 1


def test_empty_choices_is_a_response_error():
    calls: list = []
    client = client_for(lambda req: httpx.Response(200, json={"choices": []}), calls)
    provider = GroqLlmProvider(api_key=KEY, client=client)
    with pytest.raises(GroqResponseError):
        run(provider.complete("hello"))
    assert len(calls) == 1


def test_auth_failure_is_not_retried():
    calls: list = []
    client = client_for(lambda req: httpx.Response(401, json={"error": "invalid key"}), calls)
    provider = GroqLlmProvider(api_key="bad", client=client)
    with pytest.raises(GroqAuthError):
        run(provider.complete("hello"))
    assert len(calls) == 1


def test_rate_limit_retries_then_succeeds():
    calls: list = []
    states = [httpx.Response(429, json={"error": "slow down"}), ok_response()]

    def handler(req):
        calls.append(req)
        return states.pop(0)

    provider = GroqLlmProvider(api_key=KEY, client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    assert run(provider.complete("hello")) == '{"action":"finish"}'
    assert len(calls) == 2


def test_timeout_raises_after_bounded_retries():
    calls: list = []

    def handler(req):
        calls.append(req)
        raise httpx.ConnectTimeout("boom")

    provider = GroqLlmProvider(api_key=KEY, max_retries=2,
                               client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    with pytest.raises(GroqTimeoutError):
        run(provider.complete("hello"))
    assert len(calls) == 3  # initial + 2 retries, then stop


def test_persistent_server_error_surfaced_after_retries():
    calls: list = []
    client = client_for(lambda req: httpx.Response(500, json={"error": "down"}), calls)
    provider = GroqLlmProvider(api_key=KEY, max_retries=1, client=client)
    with pytest.raises(GroqServerError):
        run(provider.complete("hello"))
    assert len(calls) == 2


def test_settings_read_groq_env(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "gsk_from_env")
    monkeypatch.setenv("GROQ_MODEL", "openai/gpt-oss-120b")
    settings = Settings()
    assert settings.groq_api_key == "gsk_from_env"
    assert settings.groq_model == "openai/gpt-oss-120b"


def test_settings_defaults_and_safety(monkeypatch):
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    monkeypatch.delenv("GROQ_MODEL", raising=False)
    settings = Settings(_env_file=None)
    assert settings.groq_api_key == ""
    assert settings.groq_model == "openai/gpt-oss-20b"


def test_settings_never_leaks_key_in_repr_or_str(monkeypatch):
    secret = "gsk_super_confidential_secret_key_12345"
    monkeypatch.setenv("GROQ_API_KEY", secret)
    settings = Settings()
    assert secret not in repr(settings)
    assert secret not in str(settings)


def test_groq_provider_never_leaks_key_in_repr():
    secret = "gsk_super_confidential_secret_key_12345"
    provider = GroqLlmProvider(api_key=secret, model=MODEL)
    assert secret not in repr(provider)
    assert repr(provider) == f"<GroqLlmProvider model='{MODEL}'>"


def test_rate_limit_error_type_is_distinct():
    assert issubclass(GroqRateLimitError, Exception)
