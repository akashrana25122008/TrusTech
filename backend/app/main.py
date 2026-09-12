from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.app.services.config import get_settings
from backend.app.api.agent_step import router as agent_router
from backend.app.api.tasks import router as tasks_router

app = FastAPI(title="TrusTech Backend", version="0.1.0")

app.include_router(agent_router)
app.include_router(tasks_router)

settings = get_settings()
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {"status": "ok"}
