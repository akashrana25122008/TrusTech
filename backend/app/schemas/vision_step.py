from __future__ import annotations

from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


MAX_TASK_GOAL = 2000
MAX_REASON = 300
MAX_ACTIONS = 3
MAX_IMAGE_BYTES = 8 * 1024 * 1024
MAX_DIMENSION = 8192
MIN_EXECUTABLE_CONFIDENCE = 0.7


class VisionTask(BaseModel):
    model_config = ConfigDict(extra="forbid")

    goal: str = Field(min_length=1, max_length=MAX_TASK_GOAL)
    intent: str | None = Field(default=None, max_length=200)
    subtask: str | None = Field(default=None, max_length=500)


class VisualContext(BaseModel):
    model_config = ConfigDict(extra="forbid")

    image: str = Field(min_length=32, max_length=12 * 1024 * 1024)
    width: int = Field(gt=0, le=MAX_DIMENSION)
    height: int = Field(gt=0, le=MAX_DIMENSION)


class RedactionRegion(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(pattern=r"^r[1-9][0-9]*$")
    type: str
    method: str
    bbox: list[int] = Field(min_length=4, max_length=4)

    @field_validator("type")
    @classmethod
    def _type_known(cls, v: str) -> str:
        known = {
            "FACE", "PASSWORD", "CARD_NUMBER", "AADHAAR", "PAN", "UPI",
            "PHONE", "EMAIL", "IFSC", "PASSPORT", "VOTER_ID",
            "DRIVING_LICENSE", "SSN",
        }
        if v not in known:
            raise ValueError(f"unknown sensitive type: {v!r}")
        return v

    @field_validator("method")
    @classmethod
    def _method_known(cls, v: str) -> str:
        if v not in {"BLACKOUT", "BLUR", "MASK"}:
            raise ValueError(f"unsupported method: {v!r}")
        return v

    @field_validator("bbox")
    @classmethod
    def _bbox_sane(cls, v: list[int]) -> list[int]:
        if any(not isinstance(n, int) or isinstance(n, bool) or n < 0 or n > MAX_DIMENSION for n in v):
            raise ValueError("bbox must be non-negative integers within bounds")
        if v[2] <= 0 or v[3] <= 0:
            raise ValueError("bbox must have positive size")
        return v


class RedactionManifestModel(BaseModel):
    model_config = ConfigDict(extra="forbid")

    version: Literal["1"]
    regions: list[RedactionRegion] = Field(max_length=500)

    @field_validator("regions")
    @classmethod
    def _ids_unique(cls, v: list[RedactionRegion]) -> list[RedactionRegion]:
        ids = [r.id for r in v]
        if len(set(ids)) != len(ids):
            raise ValueError("duplicate region ids")
        return v


class VisionMetadataModel(BaseModel):
    model_config = ConfigDict(extra="forbid")

    model: str = Field(min_length=1, max_length=64)
    model_version: str = Field(min_length=1, max_length=32)
    runtime: Literal["browser-local"]
    backend: str
    inference_latency_ms: float = Field(ge=0, le=600_000)
    detections: int = Field(ge=0, le=10_000)
    capture_width: int = Field(gt=0, le=MAX_DIMENSION)
    capture_height: int = Field(gt=0, le=MAX_DIMENSION)

    @field_validator("backend")
    @classmethod
    def _backend_known(cls, v: str) -> str:
        if v not in {"webgpu", "wasm", "cpu"}:
            raise ValueError(f"unknown backend: {v!r}")
        return v


class VisionStepRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    task: VisionTask
    visual_context: VisualContext
    redaction_manifest: RedactionManifestModel
    vision_metadata: VisionMetadataModel


class PixelBBox(BaseModel):
    model_config = ConfigDict(extra="forbid")

    x: int = Field(ge=0)
    y: int = Field(ge=0)
    width: int = Field(gt=0)
    height: int = Field(gt=0)


class NormalizedBBox(BaseModel):
    model_config = ConfigDict(extra="forbid")

    x: float = Field(ge=0.0, le=1.0)
    y: float = Field(ge=0.0, le=1.0)
    width: float = Field(gt=0.0, le=1.0)
    height: float = Field(gt=0.0, le=1.0)


class PixelPoint(BaseModel):
    model_config = ConfigDict(extra="forbid")

    x: int = Field(ge=0)
    y: int = Field(ge=0)


class VisualTarget(BaseModel):
    model_config = ConfigDict(extra="forbid")

    bbox: PixelBBox
    normalized: NormalizedBBox
    point: PixelPoint


class VisualAction(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["click"]
    target: VisualTarget
    confidence: float = Field(ge=0.0, le=1.0)


class VisionStatus(str, Enum):
    SUCCESS = "success"
    TARGET_NOT_FOUND = "target_not_found"
    BLOCKED_BY_PRIVACY = "blocked_by_privacy"
    LOW_CONFIDENCE = "low_confidence"
    INVALID_MODEL_OUTPUT = "invalid_model_output"
    ERROR = "error"


class VisionStepResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    actions: list[VisualAction] = Field(max_length=MAX_ACTIONS)
    reason: str = Field(max_length=MAX_REASON)
    completion: bool
    status: VisionStatus
    model: str = ""
    redacted_regions: int = 0

    @field_validator("actions")
    @classmethod
    def _confidence_sane(cls, v: list[VisualAction]) -> list[VisualAction]:
        for a in v:
            if not 0.0 <= a.confidence <= 1.0:
                raise ValueError("confidence out of range")
        return v

    def model_dump_safe(self) -> dict[str, Any]:
        return self.model_dump(mode="json")
