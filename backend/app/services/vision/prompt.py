from __future__ import annotations


def build_vision_prompt(goal: str, intent: str | None, width: int, height: int, regions: list[dict]) -> str:
    redacted = "; ".join(f"{r['id']}:{r['type']}/{r['method']}@{r['bbox']}" for r in regions) or "none"
    return "\n".join(
        [
            "You ground a browser UI task to a visual target. Output ONE JSON object only, no prose.",
            f"Task: {goal}",
            f"Intent: {intent or 'general'}",
            f"Image: sanitized {width}x{height} screenshot. Redacted regions (intentionally hidden, NOT targets): {redacted}.",
            "Rules: identify the single visible UI element that advances the task; never target, describe, or infer redacted regions;",
            "never reproduce hidden text; if the needed element is redacted or absent, return no actions with a short reason.",
            "Schema: {\"actions\": [{\"type\": \"click\", \"target\": {\"bbox\": {\"x\": int, \"y\": int, \"width\": int, \"height\": int},",
            "\"normalized\": {\"x\": 0..1, \"y\": 0..1, \"width\": 0..1, \"height\": 0..1}, \"point\": {\"x\": int, \"y\": int}},",
            "\"confidence\": 0..1}], \"reason\": \"<=60 chars\", \"completion\": bool}.",
            "Coordinates: bbox/point in image pixels; normalized relative to image width/height; point inside bbox.",
        ]
    )
