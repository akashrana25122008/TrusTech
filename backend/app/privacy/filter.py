"""Privacy firewall — PII detection + redaction on backend-bound text.

Defense in depth behind the browser-local detector: Indic digits are
folded to ASCII first, then ASCII patterns (including India-specific
identifiers) redact. No checksums here — the extension engine validates;
the backend never lets a shaped value through.
"""

import re

# Zero code points of every Indic digit block we fold to ASCII 0-9.
_INDIC_ZEROES = (
    0x0966,  # Devanagari
    0x09E6,  # Bengali
    0x0A66,  # Gurmukhi
    0x0AE6,  # Gujarati
    0x0B66,  # Oriya
    0x0BE6,  # Tamil
    0x0C66,  # Telugu
    0x0CE6,  # Kannada
    0x0D66,  # Malayalam
    0x0660,  # Arabic-Indic
    0x06F0,  # Extended Arabic-Indic
)

_FOLD_MAP = {
    chr(zero + d): str(d) for zero in _INDIC_ZEROES for d in range(10)
}
_FOLD_RE = re.compile("|".join(re.escape(c) for c in _FOLD_MAP))

# Invisible format characters stripped before matching.
_FORMAT_RE = re.compile("[​‌‍﻿­]")

_PII_PATTERNS = {
    "email": re.compile(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", re.I),
    "credit_card": re.compile(r"(?:\d{4}[- ]?){3}\d{4}"),
    "aadhaar": re.compile(r"(?<![\d])([2-9]\d{3}\s?\d{4}\s?\d{4})(?![\d])"),
    "pan": re.compile(r"\b([A-Z]{5}[0-9]{4}[A-Z])\b", re.I),
    "phone_in": re.compile(r"(?<![\d+])((?:\+?91[\s\-]?|0[\s\-]?)?[6789](?:[\s\-]?\d){9})(?![\d])"),
    "upi": re.compile(r"\b([A-Za-z0-9._\-]{2,64}@[A-Za-z]{2,32})\b"),
    "ifsc": re.compile(r"\b([A-Za-z]{4}0[A-Za-z0-9]{6})\b"),
}

# Authentication material is redacted (never forwarded to reasoning) even
# when it arrives — the local firewall blocks it first; this is the
# second net. Patterns match VALUE shapes, not bare words, so docs that
# merely mention "token" keep working.
_SECRET_PATTERNS = {
    "password": re.compile(r"\b(passwou?rd|passwd|pwd)\b\s*[:=]\s*\S+", re.I),
    "token": re.compile(r"\bbearer\s+[A-Za-z0-9\-._~+/=]{16,}\b|\b(token|auth[_-]?token|access[_-]?token)\b\s*[:=]\s*[\"']?[A-Za-z0-9\-._~+/=]{16,}[\"']?", re.I),
    "api_key": re.compile(
        r"\bsk-[A-Za-z0-9]{16,}|\bAKIA[0-9A-Z]{16}|\b(ghp|gho)_[A-Za-z0-9]{16,}|\bxox[bpas]-[A-Za-z0-9\-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----"
    ),
    "cookie": re.compile(r"\b(sessionid|sessid|sid|session[_-]?id|phpsessid)\s*=\s*[A-Za-z0-9\-._~+/=]{8,}", re.I),
}


def _fold_digits(text: str) -> str:
    """Fold Indic digits to ASCII so one pattern set covers all scripts."""
    return _FOLD_RE.sub(lambda m: _FOLD_MAP[m.group(0)], text)


def redact(text: str) -> tuple[str, int]:
    """Redact known PII, returning sanitized text and field count."""
    folded = _FORMAT_RE.sub("", _fold_digits(text))
    # Redact on the folded copy, then map the mask back: because folding
    # is length-preserving per char (and format-strip only removes
    # zero-width chars), rescan the ORIGINAL with the same patterns after
    # folding it identically — simplest correct approach is to redact the
    # folded text and return it (downstream only needs sanitized text).
    count = 0
    for _kind, pattern in _PII_PATTERNS.items():
        matches = pattern.findall(folded)
        count += len(matches)
        folded = pattern.sub("[REDACTED]", folded)
    return folded, count


def redact_secrets(text: str) -> tuple[str, int]:
    """Redact authentication material, returning sanitized text and count."""
    folded = _FORMAT_RE.sub("", _fold_digits(text))
    count = 0
    for _kind, pattern in _SECRET_PATTERNS.items():
        matches = pattern.findall(folded)
        count += len(matches)
        folded = pattern.sub("[SECRET]", folded)
    return folded, count
