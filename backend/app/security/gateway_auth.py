"""Gateway bearer-token authentication for the backend API.

``TRUSTECH_GATEWAY_TOKEN`` (empty by default) turns on authentication:
when set, every request to a protected route must carry
``Authorization: Bearer <token>`` (fallback ``X-TrustTech-Token``). When
unset the gateway stays open so a local insecure demo works out of the
box without injecting a default secret — matching the current TrusTech
topology where the extension talks to ``http://localhost:8000``.

Never bake a token into the repo; the value exists only in the deploy
environment (or the operator's ``backend/.env``).
"""

from __future__ import annotations

import secrets

from fastapi import Header, HTTPException, status

from backend.app.services.config import get_settings


def _token_matches(provided: str | None, expected: str) -> bool:
    if not provided:
        return False
    try:
        return secrets.compare_digest(provided, expected)
    except (TypeError, ValueError):
        return False


def require_gateway_token(
    authorization: str | None = Header(default=None),
    x_trustech_token: str | None = Header(default=None, alias="X-TrustTech-Token"),
) -> None:
    """FastAPI dependency. Returns None (allows) or raises 401."""
    settings = get_settings()
    expected = settings.gateway_token
    if not expected:
        return  # token not configured — open local demo gateway
    if _token_matches(x_trustech_token, expected):
        return
    if authorization and authorization.lower().startswith("bearer "):
        if _token_matches(authorization[7:].strip(), expected):
            return
    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="gateway authentication required",
        headers={"WWW-Authenticate": "Bearer"},
    )