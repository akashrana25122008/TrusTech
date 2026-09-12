"""Centralized CORS configuration (mirrors main.py)."""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware


def apply(app: FastAPI, origins: list[str]) -> None:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )