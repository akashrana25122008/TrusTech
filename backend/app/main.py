from __future__ import annotations

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.app.security.gateway_auth import require_gateway_token
from backend.app.services.config import get_settings
from backend.app.api.agent_step import router as agent_router
from backend.app.api.ai_status import router as ai_status_router
from backend.app.api.tasks import router as tasks_router
from backend.app.api.vision import router as vision_router
from backend.app.api.vision_step import router as vision_step_router

app = FastAPI(title="TrusTech Backend", version="0.1.0")

# Protected API routes require the gateway bearer token when configured.
app.include_router(agent_router, dependencies=[Depends(require_gateway_token)])
app.include_router(ai_status_router, dependencies=[Depends(require_gateway_token)])
app.include_router(tasks_router, dependencies=[Depends(require_gateway_token)])
app.include_router(vision_router, dependencies=[Depends(require_gateway_token)])
app.include_router(vision_step_router, dependencies=[Depends(require_gateway_token)])

settings = get_settings()
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    # CORS spec forbids `*` together with credentials; the gateway is
    # bearer-token authenticated (not cookie/session-based), so credentials
    # are never exchanged and CORS stays an explicit allow-list of the
    # actual frontend origins (vite dev/preview), not "*".
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "X-TrustTech-Token"],
)


@app.get("/health")
def health():
    return {"status": "ok"}