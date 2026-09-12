from backend.app.privacy.filter import redact


def test_redact_email_and_card():
    text, count = redact("reach me at a@b.com card 4111111111111111")
    assert "[REDACTED]" in text
    assert count >= 2


def test_redact_aadhaar_pan_and_phone():
    text, count = redact("aadhaar 2345 6789 0123 pan ABCPP1234F call 9876543210")
    assert "2345" not in text
    assert "ABCPP1234F" not in text
    assert "9876543210" not in text
    assert count >= 3


def test_redact_devanagari_digits():
    text, count = redact("मेरा आधार २३४५ ६७८९ ०१२३ है")
    assert "२३४५" not in text
    assert "[REDACTED]" in text
    assert count >= 1


def test_redact_upi_and_ifsc():
    text, count = redact("pay rahul@okhdfc IFSC HDFC0001234")
    assert "rahul@okhdfc" not in text
    assert "HDFC0001234" not in text
    assert count >= 2
