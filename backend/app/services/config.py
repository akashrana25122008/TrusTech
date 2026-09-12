"""Application settings from environment variables (pydantic-settings)."""

from functools import lru_cache
from pathlib import Path

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

_BACKEND_DIR = Path(__file__).resolve().parent.parent.parent
_BACKEND_ENV = _BACKEND_DIR / ".env"
_ROOT_ENV = _BACKEND_DIR.parent / ".env"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="TRUSTECH_",
        env_file=(_BACKEND_ENV, _ROOT_ENV, ".env", "backend/.env"),
        env_file_encoding="utf-8",
        extra="ignore",
        populate_by_name=True,
    )

    cors_origins: list[str] = ["*"]
    model_uri: str = "models/"
    debug: bool = False
    # Groq credentials live ONLY in the backend environment — never in the
    # extension bundle. GROQ_MODEL selects the reasoning model (20b default,
    # 120b later) without code changes.
    # repr=False ensures the key is never leaked into logs or str/repr outputs.
    groq_api_key: str = Field(
        default="",
        repr=False,
        validation_alias=AliasChoices("GROQ_API_KEY", "TRUSTECH_GROQ_API_KEY", "groq_api_key"),
    )
    groq_model: str = Field(
        default="openai/gpt-oss-20b",
        validation_alias=AliasChoices("GROQ_MODEL", "TRUSTECH_GROQ_MODEL", "groq_model"),
    )


@lru_cache
def get_settings() -> Settings:
    return Settings()