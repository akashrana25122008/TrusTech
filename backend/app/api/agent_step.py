"""Agent step endpoint — FastAPI gateway to the multi-provider AI fallback engine.

Contract:
  Extension (sanitized) → POST /api/agent/step → AI chain (Gemini primary,
  Groq secondary, OpenRouter final) → normalized action.

The backend NEVER executes browser commands, NEVER accepts browser code, and
NEVER sees credentials (API keys stay in server env). Every proposed action
passes ``validate_tool_action`` here AND the full extension pipeline
(schema → semantic → target → risk) before anything touches the browser.

Provider failures never bubble raw detail to the client: the chain is logged
server-side and the client gets a clean, secret-free HTTP response.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from fastapi import APIRouter, HTTPException

from backend.app.privacy.filter import redact, redact_secrets
from backend.app.schemas.step import StepRequest, StepResponse, validate_tool_action
from backend.app.services.ai import AIErrorCategory
from backend.app.services.ai.errors import AIServiceError
from backend.app.services.ai.manager import AIProviderManager
from backend.app.services.config import get_settings
from backend.app.services.tools import render_tool_prompt

logger = logging.getLogger("trustech.agent_step")

router = APIRouter(tags=["agent"])


def _ai_manager() -> AIProviderManager:
    """Provider-chain seam — monkeypatched in tests, settings-driven in prod."""
    return AIProviderManager.from_settings(get_settings())


SYSTEM_PROMPT = """You are the reasoning engine for a browser agent. Output ONE JSON object only — no prose, no markdown.
It must be either {"action": {...}} or the action object itself.

The action object is FLAT: {"action": "navigate", "url": "https://…"}.
Never use a {"name": …, "args": {…}} envelope — that shape is rejected.

Optional sibling "plan": the task plan for the timeline. A list of 3-6 concise
steps, [{ "id": "step_1", "description": "…" }]. Provide "plan" only when this
is the FIRST decision (history is empty) or the current page invalidates the
earlier plan (re-plan). Descriptions must be task-specific and under 70 chars —
mention the site, query, video, or field you will touch, e.g.
{"id": "step_2", "description": "Type \"beginner C tutorial\" into the YouTube search box"}.
Do not include "plan" on routine continuation decisions.

Optional siblings on the FIRST decision only (never chain-of-thought):
- "interpretation": ONE concise sentence (under 30 words) summarizing intent,
  key constraint and destination. Never a hidden step-by-step thought process.
- "inputs": ONLY values the USER explicitly supplied in the task goal
  (e.g. "fill my name Arjun Singh" → {"name": "Arjun Singh"}). Never invent inputs.
- "generatedData": ONLY when the task asks for sample/dummy/test/example/fake
  values ("fill with sample data", "use test data", "dummy student info", …).
  REQUIRED RULES for generatedData:
  — Never fabricate real personal data or real-looking credentials.
  — Never include passwords, tokens, API keys, PINs, OTPs, card/payment numbers,
    security answers, SSN, or any secret. Use only clear, harmless placeholders.
  — Nothing here may look like it could be used for real authentication.
  Example: {"first_name": "Rahul", "last_name": "Sharma", "course": "Computer Science"}.

Strict tool catalog (name, args, constraints, expected result):
""" + render_tool_prompt() + """

Rules:
- Targets use {"elementId": "el_N"} with ids from the observation ONLY — never invent ids.
- Every value-bearing action must include "expectedOutcome" with one of:
  url_change (+urlContains), content_change, element_state, navigation, tab_switch, noop.
- If a target is unclear, prefer ask_user over guessing.
- End with a finish action (with "result") when the task is complete."""


def _build_prompt(
    req: StepRequest,
    visible_text: str,
    elements: list[dict] | None = None,
    verification_text: str | None = None,
) -> str:
    rows = elements if elements is not None else req.observation.elements
    elements_block = "\n".join(
        f"{e.get('id')} {e.get('role')} \"{str(e.get('name', ''))[:60]}\""
        for e in rows[:40]
        if e.get("id")
    )
    verification = verification_text if verification_text is not None else (
        json.dumps(req.verification) if req.verification else "none yet"
    )
    history = "\n".join(req.history[-10:]) or "none yet"
    if req.observation.pageType == "unsupported":
        capability = (
            "Page capability: INTERNAL browser page (chrome://, about:, etc.) — "
            "it exposes no DOM controls. Propose a browser-level action "
            "(navigate / new_tab / switch_tab) to reach a normal webpage first; "
            "never propose element actions, and never finish while the page is internal."
        )
    else:
        capability = "Page capability: normal webpage with DOM controls."
    return (
        f"{SYSTEM_PROMPT}\n\nTask: \"{req.task.goal}\"\nIntent: {req.task.intent}\n"
        f"History:\n{history}\nLast verification: {verification}\n\n"
        f"Current page: {req.observation.url}\nTitle: {req.observation.title}\n"
        f"{capability}\n\n"
        f"Plan/data phase: {'FIRST DECISION — include \"plan\", plus \"interpretation\" and the data siblings where applicable (see system rules).' if not req.history else 'CONTINUATION — no plan/interpretation/data unless the current page invalidates earlier steps.'}\n\n"
        f"Visible text (sanitized):\n\"\"\"{visible_text[:1500]}\"\"\"\n\n"
        f"Indexed interactive elements:\n{elements_block or 'none'}"
    )


def _parse_output(raw: str) -> dict:
    """Parse the model's raw output into the top-level JSON object."""
    text = raw.strip()
    fenced = re.match(r"```(?:json)?\s*([\s\S]*?)```", text, re.I)
    body = fenced.group(1).strip() if fenced else text
    if body.startswith("["):
        raise ValueError("model returned an array, expected one action object")
    start, end = body.find("{"), body.rfind("}")
    if start == -1 or end <= start:
        raise ValueError("model returned no JSON object")
    parsed = json.loads(body[start : end + 1])
    if not isinstance(parsed, dict):
        raise ValueError("model returned non-object JSON")
    return parsed


def _action_from(parsed: dict) -> Any:
    action_obj = parsed.get("action")
    if isinstance(action_obj, dict):
        if isinstance(action_obj.get("name"), str) and isinstance(action_obj.get("args"), dict):
            translated = dict(action_obj["args"])
            translated["action"] = action_obj["name"]
            # Carry action-level siblings the model placed outside args.
            for key in ("expectedOutcome", "result", "reason", "confidence"):
                if key in action_obj and key not in translated:
                    translated[key] = action_obj[key]
            return translated
        return action_obj
    # Tolerate the common function-call envelope by translating it into
    # the single flat action schema (still fully validated below and
    # re-validated extension-side — no second action system).
    name, args = parsed.get("name"), parsed.get("args")
    if isinstance(name, str) and isinstance(args, dict):
        translated = dict(args)
        translated["action"] = name
        return translated
    return parsed


def _extract_action(raw: str) -> Any:
    return _action_from(_parse_output(raw))


def _extract_plan(parsed: dict) -> list[dict[str, str]] | None:
    """Optional structured task plan sibling — degraded safely when malformed."""
    raw_plan = parsed.get("plan")
    if not isinstance(raw_plan, list) or not raw_plan:
        return None
    plan: list[dict[str, str]] = []
    for i, item in enumerate(raw_plan):
        if not isinstance(item, dict):
            continue
        description = item.get("description")
        if not isinstance(description, str):
            continue
        description = description.strip()
        if not description:
            continue
        plan.append(
            {
                "id": str(item.get("id") or f"step_{i + 1}"),
                "description": description[:90],
            }
        )
    return plan if plan else None


# Keys that must NEVER leave the backend, even inside model-generated sample
# data — the system must not surface real-looking credentials anywhere.
_SECRET_KEYS = (
    "password",
    "passwd",
    "pwd",
    "token",
    "accesstoken",
    "refreshtoken",
    "apikey",
    "api_key",
    "secret",
    "clientsecret",
    "credential",
    "pin",
    "otp",
    "ssn",
    "card",
    "cardnumber",
    "cvv",
    "authtoken",
    "auth",
    "privatekey",
    "signature",
)

_SECRET_KEY_RE = re.compile(
    r"|".join(re.escape(k) for k in _SECRET_KEYS), re.IGNORECASE
)


def _extract_data(parsed: dict, key: str) -> dict[str, str] | None:
    """Optional structured task-data sibling (inputs / generatedData).

    Values are coerced to plain strings, trimmed, capped, and written to a NEW
    dict. Secret-like keys are scrubbed entirely so no credential-shaped value
    ever reaches the extension or the UI.
    """
    raw = parsed.get(key)
    if not isinstance(raw, dict) or not raw:
        return None
    out: dict[str, str] = {}
    for k, v in raw.items():
        if not isinstance(k, str):
            continue
        strip_key = k.strip()
        if not strip_key or _SECRET_KEY_RE.search(strip_key):
            continue
        if isinstance(v, bool):
            text = "true" if v else "false"
        elif isinstance(v, (int, float)):
            text = str(v)
        elif isinstance(v, str):
            text = v.strip()
        else:
            continue  # nested objects/arrays are not form-fillable values
        if not text:
            continue
        out[strip_key] = text[:200]
        if len(out) >= 24:
            break
    return out or None


def _extract_interpretation(parsed: dict) -> str | None:
    text = parsed.get("interpretation")
    if not isinstance(text, str):
        return None
    text = text.strip()
    return text[:200] or None


@router.post("/api/agent/step", response_model=StepResponse)
async def agent_step(req: StepRequest) -> StepResponse:
    manager = _ai_manager()
    if not manager.has_configured_provider():
        raise HTTPException(
            status_code=503,
            detail="AI service is not configured: set GEMINI_API_KEY, GROQ_API_KEY, or OPENROUTER_API_KEY",
        )

    # Defense in depth: the extension firewall is the real boundary; redact
    # again server-side so raw PII never reaches the model. Element names
    # and verification evidence are screened too — labels can carry
    # page-derived values (e.g. an e-mail inside a link name).
    visible_text, redacted = redact(req.observation.visibleText)
    secret_text, secret_count = redact_secrets(visible_text)
    visible_text = secret_text
    redacted += secret_count
    screened_elements: list[dict] = []
    for el in req.observation.elements:
        name = el.get("name")
        if isinstance(name, str) and name:
            clean_name, n1 = redact(name)
            clean_name, n2 = redact_secrets(clean_name)
            redacted += n1 + n2
            screened_elements.append({**el, "name": clean_name})
        else:
            screened_elements.append(el)
    verification_text = json.dumps(req.verification) if req.verification else "none yet"
    verification_text, vn = redact(verification_text)
    verification_text, vn2 = redact_secrets(verification_text)
    redacted += vn + vn2

    try:
        result = await manager.complete(
            _build_prompt(req, visible_text, screened_elements, verification_text)
        )
    except AIServiceError as err:
        _abort_from_ai_error(err)

    try:
        parsed = _parse_output(result.content)
        action = validate_tool_action(_action_from(parsed))
        plan = _extract_plan(parsed)
        inputs = _extract_data(parsed, "inputs")
        generated_data = _extract_data(parsed, "generatedData")
        interpretation = _extract_interpretation(parsed)
    except (ValueError, json.JSONDecodeError) as e:
        raise HTTPException(status_code=502, detail=f"reasoning engine returned an unusable action: {e}") from None

    usage = result.usage or {}
    return StepResponse(
        action=action,
        model=result.model,
        provider=result.provider,
        usage=usage,
        redacted=redacted,
        plan=plan,
        inputs=inputs,
        generatedData=generated_data,
        interpretation=interpretation,
    )


def _abort_from_ai_error(err: AIServiceError) -> None:
    """Map a normalized AI error to a clean user-facing HTTP response.

    Provider names, latency and raw provider text are logged server-side only;
    the client receives a category-level, secret-free message. Groq rate-limit
    exhaustion is handled gracefully here (one clean 503), never surfaced as an
    application bug.
    """
    logger.error(
        "[AI] step failed provider=%s category=%s msg=%s",
        err.provider or "-",
        err.category.value,
        err.message,
    )
    if err.category == AIErrorCategory.TIMEOUT:
        raise HTTPException(status_code=504, detail="AI service timed out; please retry") from None
    if err.category in (AIErrorCategory.RATE_LIMIT, AIErrorCategory.QUOTA_EXCEEDED):
        raise HTTPException(status_code=503, detail="AI service is rate-limited; please retry shortly") from None
    if err.category == AIErrorCategory.AUTHENTICATION_ERROR:
        raise HTTPException(status_code=502, detail="AI service authentication failed (server-side key issue)") from None
    if err.category == AIErrorCategory.INVALID_RESPONSE:
        raise HTTPException(status_code=502, detail="AI service returned an unusable response") from None
    if err.category == AIErrorCategory.BAD_REQUEST:
        raise HTTPException(status_code=400, detail="AI service rejected the request as invalid") from None
    if err.category == AIErrorCategory.CONFIG:
        raise HTTPException(
            status_code=503,
            detail="AI service is not configured: set GEMINI_API_KEY, GROQ_API_KEY, or OPENROUTER_API_KEY",
        ) from None
    raise HTTPException(status_code=503, detail="AI service unavailable; please retry") from None
