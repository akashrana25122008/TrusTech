from backend.app.security.risk import assess


def test_financial_intent_is_high_risk():
    verdict = assess("click", intent="pay for train ticket")
    assert verdict["level"] == "high"
    assert verdict["allow"] is False


def test_plain_click_is_low_risk():
    verdict = assess("click", intent="open tutorial", domain="youtube.com")
    assert verdict["level"] == "low"
    assert verdict["allow"] is True