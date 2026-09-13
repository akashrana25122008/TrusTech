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

    cors_origins: list[str] = ["http://localhost:5173", "http://localhost:4173"]
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
    # Gemini is the primary provider; override order with AI_PRIMARY_PROVIDER.
    gemini_api_key: str = Field(
        default="",
        repr=False,
        validation_alias=AliasChoices("GEMINI_API_KEY", "TRUSTECH_GEMINI_API_KEY", "gemini_api_key"),
    )
    gemini_model: str = Field(
        default="gemini-2.5-flash",
        validation_alias=AliasChoices("GEMINI_MODEL", "TRUSTECH_GEMINI_MODEL", "gemini_model"),
    )
    # OpenRouter is the final fallback tier; OPENROUTER_MODEL defaults to the
    # rotating free-model virtual endpoint so we never pin an obsolete model.
    openrouter_api_key: str = Field(
        default="",
        repr=False,
        validation_alias=AliasChoices("OPENROUTER_API_KEY", "TRUSTECH_OPENROUTER_API_KEY", "openrouter_api_key"),
    )
    openrouter_model: str = Field(
        default="openrouter/free",
        validation_alias=AliasChoices("OPENROUTER_MODEL", "TRUSTECH_OPENROUTER_MODEL", "openrouter_model"),
    )
    # Provider selection + the fallback chain timers.
    ai_primary_provider: str = Field(
        default="gemini",
        validation_alias=AliasChoices("AI_PRIMARY_PROVIDER", "TRUSTECH_AI_PRIMARY_PROVIDER", "ai_primary_provider"),
    )
    ai_provider_timeout_s: float = Field(
        default=25.0,
        validation_alias=AliasChoices("AI_PROVIDER_TIMEOUT_S", "TRUSTECH_AI_PROVIDER_TIMEOUT_S", "ai_provider_timeout_s"),
    )
    ai_total_timeout_s: float = Field(
        default=50.0,
        validation_alias=AliasChoices("AI_TOTAL_TIMEOUT_S", "TRUSTECH_AI_TOTAL_TIMEOUT_S", "ai_total_timeout_s"),
    )
    # Gateway bearer token protecting non-health API routes. When EMPTY the
    # gateway runs open (local demo default); when set, every /api/* request
    # must present `Authorization: Bearer <token>`. Never a default secret.
    gateway_token: str = Field(
        default="",
        repr=False,
        validation_alias=AliasChoices("TRUSTECH_GATEWAY_TOKEN", "gateway_token"),
    )


@lru_cache
def get_settings() -> Settings:
    return Settings()