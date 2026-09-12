"""Structured tool catalog — the single source of truth for model tool calling.

Every entry the gateway exposes to Groq AND enforces in ``validate_tool_action``
comes from ``TOOL_CATALOG``: name, description, strict argument contract,
constraints, and expected-result semantics. The tool NAME set is sync-guarded
against the extension's ``ALL_ACTION_NAMES`` (see tests) — the backend must
never offer a tool the extension validator would reject (e.g. ``observe``,
which is automatic in the loop, not a model action).

Outcome vocabulary matches the real ``ExpectedOutcome`` schema:
``url_change`` (+``urlContains``), ``content_change``, ``element_state``,
``navigation``, ``tab_switch``, ``noop``.
"""

from __future__ import annotations

from typing import Any

ToolSpec = dict[str, Any]

TOOL_CATALOG: list[ToolSpec] = [
    {
        "name": "navigate",
        "description": "Navigate the working tab to a full https URL.",
        "args": {"url": "string, required, absolute https? URL of the destination"},
        "required": ["url"],
        "constraints": "Absolute URL only; javascript:/data: rejected. Works from browser-internal pages.",
        "outcome": "url_change with urlContains set to a stable substring of the destination",
    },
    {
        "name": "new_tab",
        "description": "Open a URL in a new tab (which becomes the working tab).",
        "args": {"url": "string, required"},
        "required": ["url"],
        "constraints": "Same URL rules as navigate.",
        "outcome": "url_change with urlContains",
    },
    {
        "name": "close_tab",
        "description": "Close the working tab.",
        "args": {},
        "required": [],
        "constraints": "The working tab is gone afterwards; prefer navigating unless the task needs closure.",
        "outcome": "noop — verify against the tab list, not the closed page",
    },
    {
        "name": "switch_tab",
        "description": "Switch to a tab opened earlier in this task.",
        "args": {"url": "string, optional URL substring identifying the tab"},
        "required": [],
        "constraints": "Only targets tabs from this task's history.",
        "outcome": "tab_switch",
    },
    {
        "name": "back",
        "description": "Browser back in the working tab.",
        "args": {},
        "required": [],
        "constraints": "Page history only; fails honestly with no history.",
        "outcome": "navigation",
    },
    {
        "name": "forward",
        "description": "Browser forward in the working tab.",
        "args": {},
        "required": [],
        "constraints": "Page history only; fails honestly with no history.",
        "outcome": "navigation",
    },
    {
        "name": "reload",
        "description": "Reload the working tab.",
        "args": {},
        "required": [],
        "constraints": "Invalidates the content bridge; the loop re-handshakes automatically.",
        "outcome": "navigation",
    },
    {
        "name": "click",
        "description": "Click an element from the observation.",
        "args": {"target": "{elementId} from the observation, required"},
        "required": ["target"],
        "constraints": "elementId must come from the current observation; never invent ids.",
        "outcome": "one of content_change / url_change / element_state, whichever the click should cause",
    },
    {
        "name": "double_click",
        "description": "Double-click an element from the observation.",
        "args": {"target": "{elementId}, required"},
        "required": ["target"],
        "constraints": "Same id rules as click.",
        "outcome": "content_change",
    },
    {
        "name": "type",
        "description": "Type text into an editable element.",
        "args": {"target": "{elementId}, required", "text": "string, required"},
        "required": ["target", "text"],
        "constraints": "Search queries and ordinary text are routine; secrets trigger local confirmation, so never type credentials unless the task demands it.",
        "outcome": "element_state (the typed value is read back from the element)",
    },
    {
        "name": "search",
        "description": (
            "Run a full in-page search: enter the query into a search field, "
            "submit it, and verify results. This is the ONLY honest way to "
            "search — never split it into type + press_key yourself."
        ),
        "args": {
            "target": "{elementId} of the search field, required when visible",
            "text": "string, required, the search query",
        },
        "required": ["text"],
        "constraints": (
            "The query is typed only after the input is focused and verified; "
            "submission prefers Enter, then falls back to the search button; "
            "the step succeeds only when result state is observed."
        ),
        "outcome": "url_change (results page) or content_change with result items",
    },
    {
        "name": "clear",
        "description": "Clear an editable element.",
        "args": {"target": "{elementId}, required"},
        "required": ["target"],
        "constraints": "Same id rules as click.",
        "outcome": "element_state",
    },
    {
        "name": "select",
        "description": "Choose an option in a dropdown/listbox.",
        "args": {"target": "{elementId}, required", "option": "string, required, option text or value"},
        "required": ["target", "option"],
        "constraints": "Option must exist in the named control.",
        "outcome": "element_state",
    },
    {
        "name": "check",
        "description": "Check a checkbox.",
        "args": {"target": "{elementId}, required"},
        "required": ["target"],
        "constraints": "Target must be checkable.",
        "outcome": "element_state",
    },
    {
        "name": "uncheck",
        "description": "Uncheck a checkbox.",
        "args": {"target": "{elementId}, required"},
        "required": ["target"],
        "constraints": "Target must be checkable.",
        "outcome": "element_state",
    },
    {
        "name": "radio",
        "description": "Select a radio option.",
        "args": {"target": "{elementId}, required"},
        "required": ["target"],
        "constraints": "Target must be a radio input.",
        "outcome": "element_state",
    },
    {
        "name": "scroll",
        "description": "Scroll the page or an element.",
        "args": {"target": "{elementId}, optional — omit for page scroll"},
        "required": [],
        "constraints": "Viewport movement only; never changes state.",
        "outcome": "noop",
    },
    {
        "name": "hover",
        "description": "Hover an element to reveal menus/tooltips.",
        "args": {"target": "{elementId}, optional"},
        "required": [],
        "constraints": "No click occurs.",
        "outcome": "content_change if a menu opens, else noop",
    },
    {
        "name": "focus",
        "description": "Focus an element without activating it.",
        "args": {"target": "{elementId}, required"},
        "required": ["target"],
        "constraints": "Same id rules as click.",
        "outcome": "element_state",
    },
    {
        "name": "press_key",
        "description": "Press a keyboard key (e.g. Escape, or Enter on an already-focused control).",
        "args": {"key": "string, required"},
        "required": ["key"],
        "constraints": (
            "Single keys only; no key-chord scripting. NEVER use press_key "
            "Enter to submit a search — that is the search tool's job, which "
            "verifies focus, submission, and result state."
        ),
        "outcome": "content_change (e.g. a dialog dismissed)",
    },
    {
        "name": "wait",
        "description": "Wait for dynamic content to settle.",
        "args": {"ms": "number > 0, required"},
        "required": ["ms"],
        "constraints": "Prefer the loop's automatic settling; use only for known-slow widgets.",
        "outcome": "noop",
    },
    {
        "name": "extract",
        "description": "Read text out of an element into the task result.",
        "args": {"target": "{elementId}, required"},
        "required": ["target"],
        "constraints": "Read-only; PII in the result is redacted before it leaves the page context.",
        "outcome": "content_change (result carries the extracted text)",
    },
    {
        "name": "submit",
        "description": "Submit the enclosing form of an element.",
        "args": {"target": "{elementId}, required"},
        "required": ["target"],
        "constraints": "May change server state; the local risk engine treats submission as advisory MEDIUM.",
        "outcome": "content_change or url_change",
    },
    {
        "name": "finish",
        "description": "End the task with an answer. Terminal.",
        "args": {"result": "string, required, the answer for the user"},
        "required": ["result"],
        "constraints": "Only when the goal is met and verified; never finish to escape a failure.",
        "outcome": "noop",
    },
    {
        "name": "ask_user",
        "description": "Escalate to the user with a question. Terminal for this step.",
        "args": {"reason": "string, required"},
        "required": ["reason"],
        "constraints": "Prefer over guessing when the target is ambiguous or the action is consequential.",
        "outcome": "noop",
    },
]

TOOLS: dict[str, ToolSpec] = {t["name"]: t for t in TOOL_CATALOG}
TOOL_NAMES: frozenset[str] = frozenset(TOOLS)


def render_tool_prompt() -> str:
    """Render the catalog as the strict tool section of the model prompt."""
    lines = []
    for tool in TOOL_CATALOG:
        args = "; ".join(f"{k}: {v}" for k, v in tool["args"].items()) or "none"
        lines.append(
            f"- {tool['name']}({args})\n"
            f"  {tool['description']}\n"
            f"  Constraints: {tool['constraints']}\n"
            f"  Expected result: {tool['outcome']}"
        )
    return "\n".join(lines)
