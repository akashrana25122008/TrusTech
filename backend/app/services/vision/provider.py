from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass


@dataclass(slots=True)
class VisionProviderResult:
    content: str
    provider: str
    model: str
    latency_ms: int = 0


class VisionModelProvider(ABC):
    name: str = "unknown"

    @property
    @abstractmethod
    def model(self) -> str:
        raise NotImplementedError

    def is_configured(self) -> bool:
        raise NotImplementedError

    @abstractmethod
    async def analyze_image(self, prompt: str, image_png: bytes) -> VisionProviderResult:
        raise NotImplementedError
