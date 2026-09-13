from __future__ import annotations

import base64
import time
from urllib.parse import quote

import httpx

from backend.app.services.ai.errors import AIServiceError, AIErrorCategory, classify_http_status, classify_transport_error
from backend.app.services.vision.provider import VisionModelProvider, VisionProviderResult


class GeminiVisionProvider(VisionModelProvider):
    name = "gemini-vision"

    ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"

    def __init__(
        self,
        api_key: str = "",
        model: str = "gemini-2.0-flash",
        *,
        timeout_s: float = 30.0,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self.api_key = api_key
        self._model = model
        self.timeout_s = timeout_s
        self._client = client

    @property
    def model(self) -> str:
        return self._model

    def is_configured(self) -> bool:
        return bool(self.api_key)

    async def analyze_image(self, prompt: str, image_png: bytes) -> VisionProviderResult:
        url = self.ENDPOINT.format(model=quote(self._model, safe=""))
        headers = {"x-goog-api-key": self.api_key, "Content-Type": "application/json"}
        payload = {
            "contents": [
                {
                    "parts": [
                        {"text": prompt},
                        {"inline_data": {"mime_type": "image/png", "data": base64.b64encode(image_png).decode()}},
                    ]
                }
            ],
            "generationConfig": {"temperature": 0.1, "maxOutputTokens": 512},
        }
        owns_client = self._client is None
        client = self._client or httpx.AsyncClient(timeout=self.timeout_s)
        start = time.perf_counter()
        try:
            try:
                response = await client.post(url, headers=headers, json=payload)
            except httpx.HTTPError as exc:
                raise AIServiceError(classify_transport_error(exc), provider=self.name, message=str(exc)) from exc
            if response.status_code >= 400:
                raise AIServiceError(
                    classify_http_status(self.name, response.status_code),
                    provider=self.name,
                    message=f"HTTP {response.status_code}",
                )
            text = self._extract_text(response)
            if text is None:
                raise AIServiceError(
                    AIErrorCategory.MODEL_UNAVAILABLE, provider=self.name, message="vision response carried no text"
                )
            latency = int((time.perf_counter() - start) * 1000)
            return VisionProviderResult(content=text, provider=self.name, model=self._model, latency_ms=latency)
        finally:
            if owns_client:
                await client.aclose()

    @staticmethod
    def _extract_text(response: httpx.Response) -> str | None:
        try:
            data = response.json()
        except ValueError:
            return None
        for candidate in data.get("candidates", []) if isinstance(data, dict) else []:
            content = candidate.get("content", {}) if isinstance(candidate, dict) else {}
            parts = content.get("parts", []) if isinstance(content, dict) else []
            texts = [p.get("text", "") for p in parts if isinstance(p, dict) and isinstance(p.get("text"), str)]
            joined = "".join(texts).strip()
            if joined:
                return joined
        return None
