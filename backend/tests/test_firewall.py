"""Feature #2 backend defense-in-depth: strict schemas + secret screening."""

from fastapi.testclient import TestClient

from backend.app.main import app
from backend.app.privacy.filter import redact_secrets

client = TestClient(app)

BASE_BODY = {
    "task": {"goal": "test", "intent": "general"},
    "observation": {
        "url": "https://example.com",
        "title": "t",
        "tabId": 7,
        "visibleText": "hello",
        "elements": [{"id": "el_001", "role": "button", "name": "Go"}],
    },
    "history": [],
    "verification": None,
}


def test_unknown_top_level_field_is_rejected_422():
    resp = client.post("/api/agent/step", json={**BASE_BODY, "screenshot": "data:image/png;base64,AAAA"})
    assert resp.status_code == 422


def test_unknown_observation_field_is_rejected_422():
    body = {**BASE_BODY, "observation": {**BASE_BODY["observation"], "rawHtml": "<div>hi</div>"}}
    assert client.post("/api/agent/step", json=body).status_code == 422


def test_element_with_smuggled_value_key_is_rejected_422():
    body = {
        **BASE_BODY,
        "observation": {
            **BASE_BODY["observation"],
            "elements": [{"id": "el_001", "role": "textbox", "name": "Email", "value": "a@b.com"}],
        },
    }
    assert client.post("/api/agent/step", json=body).status_code == 422


def test_oversized_visible_text_is_rejected_422():
    body = {**BASE_BODY, "observation": {**BASE_BODY["observation"], "visibleText": "x" * 9000}}
    assert client.post("/api/agent/step", json=body).status_code == 422


def test_too_many_elements_are_rejected_422():
    els = [{"id": f"el_{i:03d}", "role": "link", "name": "x"} for i in range(101)]
    body = {**BASE_BODY, "observation": {**BASE_BODY["observation"], "elements": els}}
    assert client.post("/api/agent/step", json=body).status_code == 422


def test_secrets_are_redacted_never_forwarded():
    text, count = redact_secrets("login with Bearer abcdefgh12345678 now")
    assert "[SECRET]" in text
    assert "abcdefgh12345678" not in text
    assert count >= 1


def test_secret_shaped_keys_are_redacted():
    text, count = redact_secrets("api key sk-projhunter2hunter2 leaked")
    assert "sk-projhunter2hunter2" not in text
    assert count >= 1


def test_benign_mentions_of_token_are_kept():
    text, count = redact_secrets("discuss the token economy and subway tokens")
    assert text == "discuss the token economy and subway tokens"
    assert count == 0
