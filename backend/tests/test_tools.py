"""Phase 3/18B — tool catalog: single source, extension parity, prompt render."""

import re
from pathlib import Path

from backend.app.services.tools import TOOLS, TOOL_NAMES, render_tool_prompt

REPO = Path(__file__).resolve().parents[2]


def extension_action_names() -> set[str]:
    src = (REPO / "extension/src/shared/action-schema.ts").read_text()
    block = re.search(r"ALL_ACTION_NAMES[^=]*=\s*\[(.*?)\]", src, re.S).group(1)
    return set(re.findall(r'"([^"]+)"', block))


def test_tool_names_match_extension_exactly():
    # The gateway must never offer a tool the extension validator rejects
    # (or omit one the model needs). Single source: services/tools.py.
    assert TOOL_NAMES == extension_action_names(), (
        f"backend-only: {TOOL_NAMES - extension_action_names()}, "
        f"extension-only: {extension_action_names() - TOOL_NAMES}"
    )


def test_every_tool_has_description_args_constraints_outcome():
    for name, spec in TOOLS.items():
        assert spec["description"], name
        assert isinstance(spec["args"], dict), name
        assert spec["constraints"], name
        assert spec["outcome"], name
        assert isinstance(spec["required"], list), name


def test_prompt_render_covers_every_tool_with_outcome_semantics():
    prompt = render_tool_prompt()
    for name in TOOL_NAMES:
        assert name in prompt, name
    assert "expected result" in prompt.lower()
    assert "never invent ids" in prompt


def test_required_fields_are_declared_per_kind():
    assert TOOLS["navigate"]["required"] == ["url"]
    assert set(TOOLS["type"]["required"]) == {"target", "text"}
    assert set(TOOLS["select"]["required"]) == {"target", "option"}
    assert TOOLS["finish"]["required"] == ["result"]
    assert TOOLS["scroll"]["required"] == []
