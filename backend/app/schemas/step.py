"""Step schemas — extension↔backend contract for one reasoning step.

The extension owns the authoritative action schema
(``extension/src/shared/action-schema.ts``); this module mirrors the
constraints the backend enforces BEFORE calling Groq and AFTER receiving
its answer. The extension re-validates everything again locally — the
backend gate exists to reject garbage early, never to authorize execution.
"""

from __future__ import annotations

import re
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator

from backend.app.services.tools import TOOL_NAMES, TOOLS

_ELEMENT_ID = re.compile(r"^el_[0-9]+$")

# Element descriptors may only carry these keys. Raw values, screenshots,
# selectors-with-content and any other smuggled fields are rejected (422)
# — defense in depth behind the local firewall.
_ELEMENT_KEYS = frozenset({"id", "role", "name", "tag"})

# Outbound size caps — oversized payloads are rejected, never truncated.
_MAX_VISIBLE_TEXT = 8000
_MAX_ELEMENTS = 100
_MAX_HISTORY = 50
_MAX_HISTORY_ITEM = 500
_MAX_URL = 2000
_MAX_NAME = 200


class StepTask(BaseModel):
    model_config = ConfigDict(extra="forbid")

    goal: str = Field(min_length=1, max_length=2000)
    intent: str = "general"


class StepObservation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    url: str = Field(default="", max_length=_MAX_URL)
    title: str = Field(default="", max_length=500)
    tabId: int = 0
    pageType: str = "content"
    visibleText: str = Field(default="", max_length=_MAX_VISIBLE_TEXT)
    elements: list[dict[str, Any]] = Field(default_factory=list)

    @field_validator("elements")
    @classmethod
    def _check_elements(cls, elements: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if len(elements) > _MAX_ELEMENTS:
            raise ValueError(f"too many elements ({len(elements)} > {_MAX_ELEMENTS})")
        for el in elements:
            if not isinstance(el, dict):
                raise ValueError("element must be an object")
            unknown = set(el) - _ELEMENT_KEYS
            if unknown:
                raise ValueError(f"forbidden element keys: {sorted(unknown)}")
            name = el.get("name")
            if name is not None and (not isinstance(name, str) or len(name) > _MAX_NAME):
                raise ValueError("element name must be a short string")
        return elements


class StepRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    task: StepTask
    observation: StepObservation
    history: list[str] = Field(default_factory=list)
    verification: dict[str, Any] | None = None

    @field_validator("history")
    @classmethod
    def _check_history(cls, history: list[str]) -> list[str]:
        if len(history) > _MAX_HISTORY:
            raise ValueError(f"too many history entries ({len(history)} > {_MAX_HISTORY})")
        for item in history:
            if not isinstance(item, str) or len(item) > _MAX_HISTORY_ITEM:
                raise ValueError("history entries must be short strings")
        return history


class StepResponse(BaseModel):
    action: dict[str, Any]
    model: str
    usage: dict[str, Any] = Field(default_factory=dict)
    redacted: int = 0
    # Optional structured task plan emitted on the first decision (and any
    # re-plan). When absent the extension falls back to the local task-sourced
    # steps and labels them as such.
    plan: list[dict[str, str]] | None = None
    # Task data category "user-provided": concrete values the user gave in the
    # goal (e.g. "fill my name Arjun Singh" → {"name": "Arjun Singh"}).
    inputs: dict[str, str] | None = None
    # Task data category "model-generated sample data": harmless synthetic
    # values for sample/dummy/test requests. Secret-like keys are scrubbed.
    generatedData: dict[str, str] | None = None
    # One-line task interpretation (concise summary, never chain-of-thought).
    interpretation: str | None = None


def _reject(reason: str) -> ValueError:
    return ValueError(f"invalid tool action: {reason}")


def validate_tool_action(obj: Any) -> dict[str, Any]:
    """Backend gate for a model-proposed action. Raises ValueError on reject.

    Checks shape only (known tool, required args, safe URL/target formats).
    Element EXISTENCE and liveness are checked extension-side against the live
    DOM — the backend can never authorize those.
    """
    if not isinstance(obj, dict):
        raise _reject("not a JSON object")
    name = obj.get("action")
    if name not in TOOL_NAMES:
        raise _reject(f"unknown action {name!r}")
    spec = TOOLS[name]

    for field in spec["required"]:
        if field == "target":
            target = obj.get("target")
            if not isinstance(target, dict) or not (
                target.get("elementId") or target.get("selector")
                or (target.get("role") and target.get("name"))
            ):
                raise _reject(f"{name} requires a target (elementId, role+name, or selector)")
        elif field == "url":
            url = obj.get("url")
            if not isinstance(url, str) or not url:
                raise _reject(f"{name} requires a url")
            if not url.startswith(("https://", "http://")):
                raise _reject(f"unsafe url scheme in {url!r}")
        elif field == "ms":
            ms = obj.get("ms")
            if not isinstance(ms, (int, float)) or ms <= 0:
                raise _reject("wait requires ms > 0")
        elif not isinstance(obj.get(field), str):
            raise _reject(f"{name} requires {field}")

    target = obj.get("target")
    if target is not None:
        if not isinstance(target, dict):
            raise _reject("target must be an object")
        element_id = target.get("elementId")
        if element_id is not None and (
            not isinstance(element_id, str) or not _ELEMENT_ID.match(element_id)
        ):
            raise _reject(f"invented element id {element_id!r}")

    return obj
