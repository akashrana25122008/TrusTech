"""Vision-language provider interface (backend tier, for VLM screenshots)."""

from abc import ABC, abstractmethod


class VLMProvider(ABC):
    @abstractmethod
    def describe(self, image_bytes: bytes) -> str:
        raise NotImplementedError