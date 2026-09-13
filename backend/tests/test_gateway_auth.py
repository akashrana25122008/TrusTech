"""Gateway bearer-token auth + CORS hardening (Phase 16).

Covers the security decisions behind TRUSTECH_GATEWAY_TOKEN:
  * Empty token default -> open local demo gateway (health + /api/* open).
  * Token set -> /api/* requires `Authorization: Bearer <token>` (fallback
    `X-TrustTech-Token`); /health stays public for container probes.
  * CORS: explicit frontend origin allow-list (never "*"), no credentials,
    limited methods, no allow-origin for foreign origins.
"""

from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from backend.app.main import app
import backend.app.security.gateway_auth as auth_module

client = TestClient(app)

ALLOWED_ORIGINS = ["http://localhost:5173", "http://localhost:4173"]


def _set_token(monkeypatch, token: str = "s3cret-token") -> None:
    monkeypatch.setattr(
        auth_module,
        "get_settings",
        lambda: SimpleNamespace(gateway_token=token),
    )


# ---- open gateway by default (local demo) ---------------------------------


def test_health_is_public_even_with_token(monkeypatch):
    _set_token(monkeypatch)
    res = client.get("/health")
    assert res.status_code == 200
    assert res.json() == {"status": "ok"}


def test_open_gateway_when_token_unset_allows_all_routes(monkeypatch):
    monkeypatch.setattr(
        auth_module, "get_settings", lambda: SimpleNamespace(gateway_token="")
    )
    assert client.get("/api/ai/status").status_code == 200
    res = client.post(
        "/api/agent/step",
        json={"task": {"goal": "x", "intent": "search"}},
    )
    # 422 = request reached the endpoint (auth passed); 401 would mean blocked.
    assert res.status_code == 422


# ---- token set: enforcement ------------------------------------------------


def test_missing_token_is_401(monkeypatch):
    _set_token(monkeypatch)
    res = client.get("/api/ai/status")
    assert res.status_code == 401
    assert res.headers.get("www-authenticate") == "Bearer"


def test_wrong_token_is_401(monkeypatch):
    _set_token(monkeypatch)
    res = client.get("/api/ai/status", headers={"Authorization": "Bearer wrong"})
    assert res.status_code == 401


def test_bearer_token_is_accepted(monkeypatch):
    _set_token(monkeypatch)
    res = client.get("/api/ai/status", headers={"Authorization": "Bearer s3cret-token"})
    assert res.status_code == 200


def test_alt_header_token_is_accepted(monkeypatch):
    _set_token(monkeypatch)
    res = client.get("/api/ai/status", headers={"X-TrustTech-Token": "s3cret-token"})
    assert res.status_code == 200


def test_agent_step_is_also_protected(monkeypatch):
    _set_token(monkeypatch)
    res = client.post(
        "/api/agent/step",
        json={"task": {"goal": "x", "intent": "search"}},
    )
    assert res.status_code == 401


# ---- CORS policy -----------------------------------------------------------


@pytest.mark.parametrize("origin", ALLOWED_ORIGINS)
def test_cors_preflight_allows_configured_frontend_origins(origin):
    res = client.options(
        "/api/agent/step",
        headers={
            "Origin": origin,
            "Access-Control-Request-Method": "POST",
        },
    )
    assert res.status_code == 200
    assert res.headers.get("access-control-allow-origin") == origin


def test_cors_preflight_rejects_foreign_origin():
    res = client.options(
        "/api/agent/step",
        headers={
            "Origin": "http://evil.example",
            "Access-Control-Request-Method": "POST",
        },
    )
    assert "access-control-allow-origin" not in res.headers


def test_cors_actual_response_and_no_credentials():
    res = client.get(
        "/health",
        headers={"Origin": ALLOWED_ORIGINS[0]},
    )
    assert res.status_code == 200
    assert res.headers.get("access-control-allow-origin") == ALLOWED_ORIGINS[0]
    # allow_credentials=False -> the CORS allow-credentials header must not
    # be set at all (with "*" origins + credentials the browser would refuse).
    assert res.headers.get("access-control-allow-credentials") != "true"


def test_cors_methods_are_limited():
    res = client.options(
        "/api/agent/step",
        headers={
            "Origin": ALLOWED_ORIGINS[0],
            "Access-Control-Request-Method": "DELETE",
        },
    )
    assert res.status_code in (200, 400)
    allow = res.headers.get("access-control-allow-methods", "")
    assert "DELETE" not in allow