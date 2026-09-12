"""Phase 2/18B-C — POST /api/agent/step: validation, normalization, errors."""

import json
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

import backend.app.api.agent_step as step_module
from backend.app.main import app
from backend.app.services.llm import (
    GroqAuthError,
    GroqRateLimitError,
    GroqResponseError,
    GroqServerError,
    GroqTimeoutError,
)

client = TestClient(app)

BASE_BODY = {
    "task": {"goal": "Find a C language tutorial", "intent": "search"},
    "observation": {
        "url": "https://www.youtube.com",
        "title": "YouTube",
        "tabId": 7,
        "visibleText": "Welcome",
        "elements": [{"id": "el_001", "role": "searchbox", "name": "Search"}],
    },
    "history": ["observed youtube"],
    "verification": None,
}


class FakeProvider:
    def __init__(self, raw: str, usage: dict | None = None):
        self.raw = raw
        self.last_usage = usage or {"prompt_tokens": 10}

    async def complete(self, prompt: str) -> str:
        assert "C language tutorial" in prompt
        return self.raw


class FailingProvider:
    def __init__(self, error: Exception):
        self.error = error
        self.last_usage = {}

    async def complete(self, prompt: str) -> str:
        raise self.error


@pytest.fixture
def settings(monkeypatch):
    monkeypatch.setattr(
        step_module, "get_settings",
        lambda: SimpleNamespace(groq_api_key="gsk_test", groq_model="openai/gpt-oss-20b"),
    )


@pytest.fixture
def no_key(monkeypatch):
    monkeypatch.setattr(
        step_module, "get_settings",
        lambda: SimpleNamespace(groq_api_key="", groq_model="openai/gpt-oss-20b"),
    )


def use_provider(monkeypatch, provider):
    monkeypatch.setattr(step_module, "_provider", lambda: provider)


def test_valid_step_returns_normalized_action(settings, monkeypatch):
    use_provider(monkeypatch, FakeProvider('{"action": {"action": "click", "target": {"elementId": "el_001"}}}'))
    resp = client.post("/api/agent/step", json=BASE_BODY)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["action"] == {"action": "click", "target": {"elementId": "el_001"}}
    assert body["model"] == "openai/gpt-oss-20b"
    assert body["usage"] == {"prompt_tokens": 10}


def test_bare_action_object_is_accepted(settings, monkeypatch):
    use_provider(monkeypatch, FakeProvider('```json\n{"action": "navigate", "url": "https://www.youtube.com"}\n```'))
    resp = client.post("/api/agent/step", json=BASE_BODY)
    assert resp.status_code == 200, resp.text
    assert resp.json()["action"]["url"] == "https://www.youtube.com"


def test_unknown_action_is_rejected_502(settings, monkeypatch):
    use_provider(monkeypatch, FakeProvider('{"action": {"action": "hack_the_planet"}}'))
    resp = client.post("/api/agent/step", json=BASE_BODY)
    assert resp.status_code == 502


def test_malformed_model_output_is_rejected_502(settings, monkeypatch):
    use_provider(monkeypatch, FakeProvider("sorry, no can do"))
    resp = client.post("/api/agent/step", json=BASE_BODY)
    assert resp.status_code == 502


def test_unsafe_url_and_invented_id_rejected_502(settings, monkeypatch):
    use_provider(monkeypatch, FakeProvider('{"action": "navigate", "url": "javascript:alert(1)"}'))
    assert client.post("/api/agent/step", json=BASE_BODY).status_code == 502

    use_provider(monkeypatch, FakeProvider('{"action": "click", "target": {"elementId": "evil"}}'))
    assert client.post("/api/agent/step", json=BASE_BODY).status_code == 502


def test_missing_key_is_503_without_calling_groq(no_key, monkeypatch):
    called = []
    use_provider(monkeypatch, FakeProvider('{"action": "finish"}'))
    resp = client.post("/api/agent/step", json=BASE_BODY)
    assert resp.status_code == 503
    assert "not configured" in resp.json()["detail"]
    assert "GROQ_API_KEY" in resp.json()["detail"]
    assert called == []


def test_auth_failure_is_502_and_leaks_no_key(settings, monkeypatch):
    use_provider(monkeypatch, FailingProvider(GroqAuthError("bad")))
    resp = client.post("/api/agent/step", json=BASE_BODY)
    assert resp.status_code == 502
    assert "authentication failed" in resp.json()["detail"]
    assert "gsk" not in resp.text


def test_timeout_is_503_with_timeout_detail(settings, monkeypatch):
    use_provider(monkeypatch, FailingProvider(GroqTimeoutError("slow")))
    resp = client.post("/api/agent/step", json=BASE_BODY)
    assert resp.status_code == 503
    assert "timed out" in resp.json()["detail"]


def test_rate_limit_is_503_with_rate_limit_detail(settings, monkeypatch):
    use_provider(monkeypatch, FailingProvider(GroqRateLimitError("Groq rate limit exceeded (HTTP 429)")))
    resp = client.post("/api/agent/step", json=BASE_BODY)
    assert resp.status_code == 503
    assert "rate-limited" in resp.json()["detail"]
    assert "429" in resp.json()["detail"]


def test_server_error_is_503_with_error_class(settings, monkeypatch):
    use_provider(monkeypatch, FailingProvider(GroqServerError("Groq server error (HTTP 500)")))
    resp = client.post("/api/agent/step", json=BASE_BODY)
    assert resp.status_code == 503
    assert "GroqServerError" in resp.json()["detail"]


def test_bad_response_body_is_502_parse_class(settings, monkeypatch):
    use_provider(monkeypatch, FailingProvider(GroqResponseError("Groq returned invalid JSON")))
    resp = client.post("/api/agent/step", json=BASE_BODY)
    assert resp.status_code == 502
    assert "unusable response" in resp.json()["detail"]


def test_invalid_request_body_is_422():
    resp = client.post("/api/agent/step", json={"observation": {}})
    assert resp.status_code == 422


def test_pii_in_observation_is_redacted_before_reasoning(settings, monkeypatch):
    seen: dict = {}

    class SpyProvider(FakeProvider):
        async def complete(self, prompt: str) -> str:
            seen["prompt"] = prompt
            return self.raw

    use_provider(monkeypatch, SpyProvider('{"action": "finish", "result": "done"}'))
    body = dict(BASE_BODY)
    body["observation"] = dict(BASE_BODY["observation"], visibleText="contact a@b.com now")
    resp = client.post("/api/agent/step", json=body)
    assert resp.status_code == 200, resp.text
    assert "a@b.com" not in seen["prompt"]
    assert resp.json()["redacted"] >= 1


def test_internal_page_prompt_signals_browser_level_capability(settings, monkeypatch):
    seen: dict = {}

    class SpyProvider(FakeProvider):
        async def complete(self, prompt: str) -> str:
            seen["prompt"] = prompt
            return self.raw

    use_provider(monkeypatch, SpyProvider('{"action": {"action": "navigate", "url": "https://www.youtube.com"}}'))
    body = dict(BASE_BODY)
    body["observation"] = dict(
        BASE_BODY["observation"],
        url="chrome://newtab/",
        pageType="unsupported",
        visibleText="",
        elements=[],
    )
    resp = client.post("/api/agent/step", json=body)
    assert resp.status_code == 200, resp.text
    assert "INTERNAL browser page" in seen["prompt"]
    assert "navigate" in seen["prompt"]
    assert "never finish while the page is internal" in seen["prompt"]


def test_normal_page_prompt_declares_dom_capability(settings, monkeypatch):
    seen: dict = {}

    class SpyProvider(FakeProvider):
        async def complete(self, prompt: str) -> str:
            seen["prompt"] = prompt
            return self.raw

    use_provider(monkeypatch, SpyProvider('{"action": {"action": "click", "target": {"elementId": "el_001"}}}'))
    resp = client.post("/api/agent/step", json=BASE_BODY)
    assert resp.status_code == 200, resp.text
    assert "normal webpage with DOM controls" in seen["prompt"]
    assert "INTERNAL browser page" not in seen["prompt"]


def test_function_call_envelope_is_normalized_not_rejected(settings, monkeypatch):
    use_provider(
        monkeypatch,
        FakeProvider('{"action": {"name": "navigate", "args": {"url": "https://www.youtube.com/results?q=x"}, "expectedOutcome": {"type": "url_change", "urlContains": "youtube.com"}}}'),
    )
    resp = client.post("/api/agent/step", json=BASE_BODY)
    assert resp.status_code == 200, resp.text
    action = resp.json()["action"]
    assert action["action"] == "navigate"
    assert action["url"] == "https://www.youtube.com/results?q=x"
    assert action["expectedOutcome"] == {"type": "url_change", "urlContains": "youtube.com"}


def test_bare_function_call_envelope_is_normalized(settings, monkeypatch):
    use_provider(
        monkeypatch,
        FakeProvider('{"name": "click", "args": {"target": {"elementId": "el_001"}}}'),
    )
    resp = client.post("/api/agent/step", json=BASE_BODY)
    assert resp.status_code == 200, resp.text
    assert resp.json()["action"] == {"action": "click", "target": {"elementId": "el_001"}}


def test_prompt_forbids_name_args_envelope(settings, monkeypatch):
    seen: dict = {}

    class SpyProvider(FakeProvider):
        async def complete(self, prompt: str) -> str:
            seen["prompt"] = prompt
            return self.raw

    use_provider(monkeypatch, SpyProvider('{"action": {"action": "finish", "result": "done"}}'))
    assert client.post("/api/agent/step", json=BASE_BODY).status_code == 200
    assert "Never use" in seen["prompt"] and "envelope" in seen["prompt"]


# ---------------------------------------------------------------------------
# Tool plan — the timeline's structured task plan from the reasoning provider.
# ---------------------------------------------------------------------------


def test_plan_is_emitted_on_first_decision(settings, monkeypatch):
    raw = json.dumps(
        {
            "action": {"action": "click", "target": {"elementId": "el_001"}},
            "plan": [
                {"id": "step_1", "description": "Open the site"},
                {"id": "step_2", "description": "Type the query"},
            ],
        }
    )
    use_provider(monkeypatch, FakeProvider(raw))
    resp = client.post("/api/agent/step", json={**BASE_BODY, "history": []})
    assert resp.status_code == 200, resp.text
    assert resp.json()["plan"] == [
        {"id": "step_1", "description": "Open the site"},
        {"id": "step_2", "description": "Type the query"},
    ]


def test_plan_absent_on_continuation_when_not_provided(settings, monkeypatch):
    use_provider(monkeypatch, FakeProvider('{"action": {"action": "click", "target": {"elementId": "el_001"}}}'))
    resp = client.post("/api/agent/step", json=BASE_BODY)
    assert resp.status_code == 200, resp.text
    assert resp.json()["plan"] is None


def test_plan_degraded_when_malformed_items_are_dropped(settings, monkeypatch):
    raw = json.dumps(
        {
            "action": {"action": "click", "target": {"elementId": "el_001"}},
            "plan": [
                {"id": 1},  # no description
                {"description": 42},  # non-string description
                {"id": "step_3", "description": "  a valid step  "},
                "not-an-object",
            ],
        }
    )
    use_provider(monkeypatch, FakeProvider(raw))
    resp = client.post("/api/agent/step", json={**BASE_BODY, "history": []})
    assert resp.status_code == 200, resp.text
    assert resp.json()["plan"] == [{"id": "step_3", "description": "a valid step"}]


def test_envelope_with_plan_sibling_is_returned_with_action(settings, monkeypatch):
    raw = json.dumps(
        {
            "name": "click",
            "args": {"target": {"elementId": "el_001"}},
            "plan": [{"id": "step_1", "description": "Open the page"}],
        }
    )
    use_provider(monkeypatch, FakeProvider(raw))
    resp = client.post("/api/agent/step", json={**BASE_BODY, "history": []})
    assert resp.status_code == 200, resp.text
    assert resp.json()["action"] == {"action": "click", "target": {"elementId": "el_001"}}
    assert resp.json()["plan"] == [{"id": "step_1", "description": "Open the page"}]


def test_first_decision_prompt_requests_a_plan(settings, monkeypatch):
    seen: dict = {}

    class SpyProvider(FakeProvider):
        async def complete(self, prompt: str) -> str:
            seen["prompt"] = prompt
            return self.raw

    use_provider(monkeypatch, SpyProvider('{"action": {"action": "finish", "result": "done"}}'))
    assert client.post("/api/agent/step", json={**BASE_BODY, "history": []}).status_code == 200
    assert 'FIRST DECISION — include "plan"' in seen["prompt"]
    assert '"plan"' in seen["prompt"] and "3-6" in seen["prompt"]


def test_first_decision_prompt_requests_data_siblings(settings, monkeypatch):
    seen: dict = {}

    class SpyProvider(FakeProvider):
        async def complete(self, prompt: str) -> str:
            seen["prompt"] = prompt
            return self.raw

    use_provider(monkeypatch, SpyProvider('{"action": {"action": "finish", "result": "done"}}'))
    assert client.post("/api/agent/step", json={**BASE_BODY, "history": []}).status_code == 200
    assert '"interpretation"' in seen["prompt"]
    assert '"generatedData"' in seen["prompt"]
    assert '"inputs"' in seen["prompt"]


# Task data — user-provided inputs vs model-generated sample data.
# ---------------------------------------------------------------------------


def test_inputs_and_generated_data_returned_on_first_decision(settings, monkeypatch):
    raw = json.dumps(
        {
            "action": {"action": "click", "target": {"elementId": "el_001"}},
            "interpretation": "Fill the registration form with harmless sample data.",
            "inputs": {"name": "Arjun Singh", "email": "arjun@example.in"},
            "generatedData": {"first_name": "Rahul", "course": "Computer Science", "year": 2026},
        }
    )
    use_provider(monkeypatch, FakeProvider(raw))
    resp = client.post("/api/agent/step", json={**BASE_BODY, "history": []})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["interpretation"] == "Fill the registration form with harmless sample data."
    assert body["inputs"] == {"name": "Arjun Singh", "email": "arjun@example.in"}
    assert body["generatedData"] == {"first_name": "Rahul", "course": "Computer Science", "year": "2026"}


def test_secret_like_keys_are_scrubbed_from_generated_data(settings, monkeypatch):
    raw = json.dumps(
        {
            "action": {"action": "click", "target": {"elementId": "el_001"}},
            "generatedData": {
                "first_name": "Rahul",
                "password": "P@ssw0rd123",
                "apiKey": "sk-proj-hunter2",
                "email": "rahul@example.in",
                "cardNumber": "4111 1111 1111 1111",
                "token": "eyJhbGciOiJIUzI1NiJ9",
                "phone": "9876543210",
            },
        }
    )
    use_provider(monkeypatch, FakeProvider(raw))
    resp = client.post("/api/agent/step", json={**BASE_BODY, "history": []})
    assert resp.status_code == 200, resp.text
    assert resp.json()["generatedData"] == {
        "first_name": "Rahul",
        "email": "rahul@example.in",
        "phone": "9876543210",
    }


def test_data_absent_when_not_provided(settings, monkeypatch):
    use_provider(monkeypatch, FakeProvider('{"action": {"action": "click", "target": {"elementId": "el_001"}}}'))
    resp = client.post("/api/agent/step", json=BASE_BODY)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["inputs"] is None
    assert body["generatedData"] is None
    assert body["interpretation"] is None


def test_non_string_or_nested_data_values_are_dropped(settings, monkeypatch):
    raw = json.dumps(
        {
            "action": {"action": "click", "target": {"elementId": "el_001"}},
            "generatedData": {
                "name": "Rahul",
                "nested": {"a": 1},
                "empty": "   ",
                "long": "x" * 500,
                "count": 3,
            },
        }
    )
    use_provider(monkeypatch, FakeProvider(raw))
    resp = client.post("/api/agent/step", json={**BASE_BODY, "history": []})
    assert resp.status_code == 200, resp.text
    generated = resp.json()["generatedData"]
    assert generated["name"] == "Rahul"
    assert generated["count"] == "3"
    assert "nested" not in generated
    assert "empty" not in generated
    assert len(generated["long"]) == 200
