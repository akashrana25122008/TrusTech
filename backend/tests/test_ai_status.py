"""GET /api/ai/status — provider configuration probe (Phase 19).

The status endpoint is an operator/judge aid: it reports the provider
chain, models and which providers are configured. It must NEVER emit
credential material, and it must stay truthful when nothing is wired up.
"""

from types import SimpleNamespace

from fastapi.testclient import TestClient

from backend.app.main import app
import backend.app.api.ai_status as status_module
from backend.app.services.ai.manager import CANONICAL_ORDER

client = TestClient(app)


def _settings(**overrides) -> SimpleNamespace:
    base = {
        "gemini_api_key": "gsk-dummy-gemini",
        "gemini_model": "gemini-2.5-flash",
        "groq_api_key": "",
        "groq_model": "openai/gpt-oss-20b",
        "openrouter_api_key": "",
        "openrouter_model": "openrouter/free",
        "ai_primary_provider": "gemini",
        "ai_provider_timeout_s": 25.0,
        "ai_total_timeout_s": 50.0,
    }
    base.update(overrides)
    return SimpleNamespace(**base)


def test_status_reports_chain_and_configured(monkeypatch):
    monkeypatch.setattr(status_module, "get_settings", lambda: _settings())
    res = client.get("/api/ai/status")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "ok"
    names = [p["name"] for p in body["providers"]]
    assert names == list(CANONICAL_ORDER)
    assert body["primary"] == "gemini"
    assert body["configured"] == ["gemini"]
    gemini = body["providers"][0]
    assert gemini["model"] == "gemini-2.5-flash"
    assert gemini["configured"] is True
    assert body["providers"][1]["configured"] is False


def test_primary_override_is_reflected(monkeypatch):
    settings = _settings(ai_primary_provider="groq", groq_api_key="gsk-live")
    monkeypatch.setattr(status_module, "get_settings", lambda: settings)
    body = client.get("/api/ai/status").json()
    assert body["providers"][0]["name"] == "groq"
    assert "groq" in body["configured"]


def test_no_provider_configured_says_so_instead_of_failing(monkeypatch):
    monkeypatch.setattr(
        status_module,
        "get_settings",
        lambda: _settings(
            gemini_api_key="",
            groq_api_key="",
            openrouter_api_key="",
        ),
    )
    res = client.get("/api/ai/status")
    assert res.status_code == 200
    assert res.json()["status"] == "no_provider_configured"
    assert res.json()["configured"] == []


def test_status_never_leaks_credential_material(monkeypatch):
    monkeypatch.setattr(status_module, "get_settings", lambda: _settings())
    text = client.get("/api/ai/status").text
    for forbidden in ("gsk", "api_key", "API_KEY", "Bearer", "sk-"):
        assert forbidden not in text