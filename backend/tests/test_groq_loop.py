"""Master-loop Attempt 1 — Groq reasoning path through the REAL gateway.

Exercises the production chain with only the Groq HTTP weights replaced
by an observation-driven script (httpx MockTransport):
  sanitize → prompt build → provider request → Groq reply → parse →
  validate_tool_action → StepResponse.

The scripted Groq reads the CURRENT observation from each prompt (page URL
+ element ids) and answers like the model should. If any link in the real
chain breaks (prompt missing data, backend rejecting a valid action, stale
observation forwarded), this test fails at the exact stage.
"""

import json
import re
from types import SimpleNamespace

import httpx
import pytest
from fastapi.testclient import TestClient

import backend.app.api.agent_step as step_module
from backend.app.main import app
from backend.app.services.llm import GroqLlmProvider

client = TestClient(app)

GOAL = "Find a beginner C language tutorial on YouTube."

HOME_ELEMENTS = [{"id": "el_010", "role": "searchbox", "name": "Search"}]
RESULTS_ELEMENTS = [
    {"id": "el_010", "role": "searchbox", "name": "Search"},
    {"id": "el_201", "role": "link", "name": "C Language Tutorial for Beginners"},
]


def page_of(prompt: str) -> str:
    m = re.search(r"^Current page: (\S+)", prompt, re.M)
    return m.group(1) if m else ""


def groq_script(request: httpx.Request) -> httpx.Response:
    """Observation-driven stand-in for Groq weights."""
    prompt = json.loads(request.content)["messages"][0]["content"]
    url = page_of(prompt)
    if "chrome://newtab/" in url:
        action = {
            "action": "navigate",
            "url": "https://www.youtube.com/",
            "expectedOutcome": {"type": "url_change", "urlContains": "youtube.com"},
        }
    elif "results" in url:
        assert "el_201" in prompt, "results observation must carry result ids"
        action = {
            "action": "click",
            "target": {"elementId": "el_201"},
            "expectedOutcome": {"type": "url_change", "urlContains": "watch"},
        }
    elif "watch" in url:
        action = {"action": "finish", "result": "Opened beginner C tutorial"}
    else:
        assert "el_010" in prompt, "homepage observation must carry the searchbox id"
        action = {
            "action": "type",
            "target": {"elementId": "el_010"},
            "text": "beginner C language tutorial",
            "expectedOutcome": {"type": "element_state"},
        }
    body = {
        "choices": [{"message": {"content": json.dumps({"action": action})}}],
        "usage": {"prompt_tokens": 10, "completion_tokens": 5},
    }
    return httpx.Response(200, json=body)


@pytest.fixture
def settings(monkeypatch):
    monkeypatch.setattr(
        step_module, "get_settings",
        lambda: SimpleNamespace(groq_api_key="gsk_test", groq_model="openai/gpt-oss-20b"),
    )


def use_scripted_groq(monkeypatch):
    def provider():
        transport = httpx.MockTransport(groq_script)
        return GroqLlmProvider(api_key="gsk_test", client=httpx.AsyncClient(transport=transport))
    monkeypatch.setattr(step_module, "_provider", provider)


def observe(url, visible_text, elements, page_type="content"):
    return {
        "url": url, "title": "t", "tabId": 7, "pageType": page_type,
        "visibleText": visible_text, "elements": elements,
    }


def step(task_goal, observation, history, monkeypatch_holder=None):
    return client.post("/api/agent/step", json={
        "task": {"goal": task_goal, "intent": "search"},
        "observation": observation,
        "history": history,
        "verification": None,
    })


def test_groq_path_drives_homepage_search(settings, monkeypatch):
    use_scripted_groq(monkeypatch)
    prompts: list[str] = []
    orig_complete = GroqLlmProvider.complete

    async def spy(self, prompt: str):
        prompts.append(prompt)
        return await orig_complete(self, prompt)

    monkeypatch.setattr(GroqLlmProvider, "complete", spy)

    history: list[str] = []

    # 1. chrome://newtab/ → Groq must navigate (INTERNAL guidance present).
    r = step(GOAL, observe("chrome://newtab/", "", [], "unsupported"), history)
    assert r.status_code == 200, r.text
    assert r.json()["action"]["action"] == "navigate"
    assert r.json()["action"]["url"] == "https://www.youtube.com/"
    assert "INTERNAL browser page" in prompts[-1]
    assert "never finish while the page is internal" in prompts[-1]
    history.append("navigate https://www.youtube.com/: ok")

    # 2. Fresh YouTube homepage (NOT newtab state) → Groq types the query.
    r = step(GOAL, observe("https://www.youtube.com/", "YouTube Home Search", HOME_ELEMENTS), history)
    assert r.status_code == 200, r.text
    action = r.json()["action"]
    assert action["action"] == "type", action
    assert action["target"] == {"elementId": "el_010"}
    assert action["text"] == "beginner C language tutorial"
    assert "chrome://newtab" not in prompts[-1], "stale pre-navigation state leaked to Groq"
    assert "normal webpage with DOM controls" in prompts[-1]
    history.append("type el_010: ok")

    # 3. Results page → Groq clicks a result (never Google).
    r = step(
        GOAL,
        observe("https://www.youtube.com/results?search_query=beginner", "results", RESULTS_ELEMENTS),
        history,
    )
    assert r.status_code == 200, r.text
    assert r.json()["action"]["action"] == "click"
    history.append("click el_201: ok")

    # 4. Watch page → Groq finishes with the result.
    r = step(GOAL, observe("https://www.youtube.com/watch?v=abc", "video playing", []), history)
    assert r.status_code == 200, r.text
    assert r.json()["action"]["action"] == "finish"


def test_groq_garbage_is_502_not_silent_success(settings, monkeypatch):
    def provider():
        async def broken(prompt: str) -> str:
            return "sorry, no can do"
        transport = httpx.MockTransport(lambda req: httpx.Response(200, json={
            "choices": [{"message": {"content": "sorry, no can do"}}], "usage": {},
        }))
        return GroqLlmProvider(api_key="gsk_test", client=httpx.AsyncClient(transport=transport))

    monkeypatch.setattr(step_module, "_provider", provider)
    r = step(GOAL, observe("https://www.youtube.com/", "home", HOME_ELEMENTS), [])
    assert r.status_code == 502
