"""Action Risk Engine — backend mirror of the extension risk decisions."""

FINANCIAL = ("pay", "checkout", "purchase", "order", "book")


def assess(action: str, intent: str = "", domain: str | None = None) -> dict:
    """Return a risk verdict for a planned action."""
    level = "low"
    reasons: list[str] = []
    low = intent.lower()

    if any(word in low for word in FINANCIAL):
        level = "high"
        reasons.append("financial action")
    if domain and domain not in ("youtube.com", "google.com"):
        if level != "high":
            level = "medium"
        reasons.append(f"untrusted domain {domain}")

    return {"action": action, "level": level, "allow": level != "high", "reasons": reasons}