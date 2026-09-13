"""Phase 5 — POST /vision_step: schemas, grounding, privacy overlap, failures."""

import base64
import struct
import zlib
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

import backend.app.api.vision_step as vision_module
from backend.app.main import app
from backend.app.services.vision.grounding import (
    authorize_actions,
    bbox_iou,
    normalize_actions,
    normalize_target,
    parse_model_json,
    point_in_rect,
)
from backend.app.services.vision.prompt import build_vision_prompt
from backend.app.services.vision.provider import VisionModelProvider, VisionProviderResult
from backend.app.services.vision.service import VisionService

client = TestClient(app)


def tiny_png(width=640, height=480):
    raw = b"".join(b"\x00" + bytes((10, 20, 30, 255)) * width for _ in range(height))
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)

    def chunk(typ, data):
        c = struct.pack(">I", len(data)) + typ + data
        return c + struct.pack(">I", zlib.crc32(typ + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")
    return "data:image/png;base64," + base64.b64encode(png).decode()


def manifest(regions=None):
    return {
        "version": "1",
        "regions": regions
        if regions is not None
        else [{"id": "r1", "type": "PASSWORD", "method": "BLACKOUT", "bbox": [0, 0, 120, 60]}],
    }


def metadata():
    return {
        "model": "yolos-tiny",
        "model_version": "q8",
        "runtime": "browser-local",
        "backend": "cpu",
        "inference_latency_ms": 41.5,
        "detections": 2,
        "capture_width": 640,
        "capture_height": 480,
    }


def body(**over):
    base = {
        "task": {"goal": "Click the Submit application button"},
        "visual_context": {"image": tiny_png(), "width": 640, "height": 480},
        "redaction_manifest": manifest(),
        "vision_metadata": metadata(),
    }
    base.update(over)
    return base


GOOD_MODEL_OUTPUT = (
    '{"actions": [{"type": "click", "target": {"bbox": {"x": 400, "y": 300, "width": 165, "height": 84}, '
    '"normalized": {"x": 0.625, "y": 0.625, "width": 0.258, "height": 0.175}, '
    '"point": {"x": 482, "y": 342}}, "confidence": 0.94}], '
    '"reason": "Submit application button", "completion": false}'
)


class FakeVisionProvider(VisionModelProvider):
    name = "fake-vision"

    def __init__(self, content=GOOD_MODEL_OUTPUT, configured=True):
        self._content = content
        self._configured = configured
        self.calls = 0

    @property
    def model(self):
        return "fake-vlm"

    def is_configured(self):
        return self._configured

    async def analyze_image(self, prompt, image_png):
        self.calls += 1
        assert isinstance(image_png, bytes)
        return VisionProviderResult(content=self._content, provider=self.name, model=self.model, latency_ms=7)


@pytest.fixture
def vision_service(monkeypatch):
    provider = FakeVisionProvider()
    monkeypatch.setattr(vision_module, "_vision_service", lambda: VisionService(provider))
    return provider


@pytest.fixture
def no_provider(monkeypatch):
    monkeypatch.setattr(vision_module, "_vision_service", lambda: VisionService(None))


def test_prompt_mentions_redactions_and_json_only():
    prompt = build_vision_prompt("Submit it", "form", 640, 480, [{"id": "r1", "type": "FACE", "method": "BLUR", "bbox": [1, 2, 3, 4]}])
    assert "Submit it" in prompt
    assert "r1:FACE/BLUR" in prompt
    assert "JSON object only" in prompt


def test_parse_rejects_non_json():
    with pytest.raises(ValueError):
        parse_model_json("just prose")
    assert parse_model_json("```json\n" + GOOD_MODEL_OUTPUT + "\n```")["reason"] == "Submit application button"


def test_normalize_target_converts_and_repairs():
    target = {
        "bbox": {"x": 400, "y": 300, "width": 165, "height": 84},
        "normalized": {"x": 0.625, "y": 0.625, "width": 0.258, "height": 0.175},
        "point": {"x": 10, "y": 10},
    }
    out = normalize_target(target, 640, 480)
    assert out is not None
    assert out["point"] == {"x": 482, "y": 342}
    assert out["normalized"]["x"] == round(400 / 640, 4)


def test_normalize_target_rejects_out_of_range():
    bad = {
        "bbox": {"x": 0, "y": 0, "width": 10, "height": 10},
        "normalized": {"x": 1.5, "y": 0, "width": 0.1, "height": 0.1},
        "point": {"x": 1, "y": 1},
    }
    assert normalize_target(bad, 640, 480) is None


def test_overlap_helpers():
    assert point_in_rect(5, 5, [0, 0, 10, 10])
    assert not point_in_rect(10, 10, [0, 0, 10, 10])
    assert bbox_iou([0, 0, 10, 10], [0, 0, 10, 10]) == 1.0
    assert bbox_iou([0, 0, 10, 10], [20, 20, 5, 5]) == 0.0


def test_authorize_blocks_overlap_and_low_confidence():
    regions = [{"id": "r1", "type": "PASSWORD", "method": "BLACKOUT", "bbox": [400, 300, 165, 84]}]
    actions, _, _ = normalize_actions(__import__("json").loads(GOOD_MODEL_OUTPUT), 640, 480)
    allowed, verdict = authorize_actions(actions, regions)
    assert allowed == [] and verdict == "blocked_by_privacy"
    low = [{**actions[0], "confidence": 0.2}]
    allowed, verdict = authorize_actions(low, [])
    assert allowed == [] and verdict == "low_confidence"
    allowed, verdict = authorize_actions(actions, [])
    assert verdict == "success" and len(allowed) == 1


def test_valid_request_returns_typed_click(vision_service):
    resp = client.post("/vision_step", json=body())
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["status"] == "success"
    assert data["completion"] is False
    assert len(data["actions"]) == 1
    action = data["actions"][0]
    assert action["type"] == "click"
    assert action["target"]["point"] == {"x": 482, "y": 342}
    assert action["target"]["bbox"] == {"x": 400, "y": 300, "width": 165, "height": 84}
    assert action["target"]["normalized"]["x"] == round(400 / 640, 4)
    assert 0.0 <= action["confidence"] <= 1.0
    assert data["redacted_regions"] == 1
    assert vision_service.calls == 1


def test_invalid_manifest_never_calls_vlm(vision_service):
    bad = body()
    bad["redaction_manifest"]["version"] = "9"
    assert client.post("/vision_step", json=bad).status_code == 422
    assert vision_service.calls == 0


def test_malformed_image_never_calls_vlm(vision_service):
    bad = body()
    bad["visual_context"]["image"] = "data:image/png;base64,!!!!"
    assert client.post("/vision_step", json=bad).status_code == 422
    assert vision_service.calls == 0


def test_target_inside_redaction_is_blocked(vision_service):
    overlapping = (
        '{"actions": [{"type": "click", "target": {"bbox": {"x": 10, "y": 10, "width": 60, "height": 30}, '
        '"normalized": {"x": 0.016, "y": 0.021, "width": 0.094, "height": 0.062}, "point": {"x": 40, "y": 25}}, '
        '"confidence": 0.99}], "reason": "password field", "completion": false}'
    )
    vision_service._content = overlapping
    resp = client.post("/vision_step", json=body())
    assert resp.status_code == 200
    assert resp.json()["status"] == "blocked_by_privacy"
    assert resp.json()["actions"] == []


def test_low_confidence_yields_no_action(vision_service):
    vision_service._content = GOOD_MODEL_OUTPUT.replace("0.94", "0.2")
    resp = client.post("/vision_step", json=body())
    assert resp.json()["status"] == "low_confidence"
    assert resp.json()["actions"] == []


def test_malformed_model_output_yields_structured_failure(vision_service):
    vision_service._content = "here is a button maybe"
    resp = client.post("/vision_step", json=body())
    assert resp.json()["status"] == "invalid_model_output"
    assert resp.json()["actions"] == []
    assert resp.json()["completion"] is False


def test_unconfigured_provider_is_503(vision_service, no_provider):
    resp = client.post("/vision_step", json=body())
    assert resp.status_code == 503


def test_multi_action_response_is_bounded(vision_service):
    one = GOOD_MODEL_OUTPUT
    many = one.replace('"completion": false', '"completion": false').replace(
        '"actions": [', '"actions": [{"type": "click", "target": {"bbox": {"x": 500, "y": 400, "width": 40, "height": 20}, "normalized": {"x": 0.78, "y": 0.83, "width": 0.06, "height": 0.04}, "point": {"x": 520, "y": 410}}, "confidence": 0.9}, {"type": "click", "target": {"bbox": {"x": 500, "y": 400, "width": 40, "height": 20}, "normalized": {"x": 0.78, "y": 0.83, "width": 0.06, "height": 0.04}, "point": {"x": 520, "y": 410}}, "confidence": 0.9}, {"type": "click", "target": {"bbox": {"x": 500, "y": 400, "width": 40, "height": 20}, "normalized": {"x": 0.78, "y": 0.83, "width": 0.06, "height": 0.04}, "point": {"x": 520, "y": 410}}, "confidence": 0.9}, {"type": "click", "target": {"bbox": {"x": 500, "y": 400, "width": 40, "height": 20}, "normalized": {"x": 0.78, "y": 0.83, "width": 0.06, "height": 0.04}, "point": {"x": 520, "y": 410}}, "confidence": 0.9}, '
    )
    vision_service._content = many
    resp = client.post("/vision_step", json=body())
    assert len(resp.json()["actions"]) <= 3


def test_e2e_grounding_contract(vision_service):
    resp = client.post("/vision_step", json=body())
    data = resp.json()
    assert set(data) >= {"actions", "reason", "completion", "status"}
    for action in data["actions"]:
        assert set(action) == {"type", "target", "confidence"}
        assert set(action["target"]) == {"bbox", "normalized", "point"}


def test_missing_task_field_is_422(vision_service):
    bad = body()
    del bad["task"]
    assert client.post("/vision_step", json=bad).status_code == 422
    assert vision_service.calls == 0


def test_oversized_manifest_region_count_rejected(vision_service):
    bad = body()
    bad["redaction_manifest"]["regions"] = [
        {"id": f"r{i + 1}", "type": "EMAIL", "method": "MASK", "bbox": [i % 600, 0, 10, 10]} for i in range(501)
    ]
    assert client.post("/vision_step", json=bad).status_code == 422
    assert vision_service.calls == 0


def _iou(a, b):
    from backend.app.services.vision.grounding import bbox_iou

    return bbox_iou(a, b)


def test_e2e_submit_button_grounding_accuracy(vision_service):
    truth = [400, 300, 165, 84]
    resp = client.post("/vision_step", json=body())
    assert resp.status_code == 200
    action = resp.json()["actions"][0]
    predicted = [action["target"]["bbox"][k] for k in ("x", "y", "width", "height")]
    assert _iou(predicted, truth) == 1.0
    point = action["target"]["point"]
    assert truth[0] <= point["x"] < truth[0] + truth[2]
    assert truth[1] <= point["y"] < truth[1] + truth[3]
    assert action["type"] == "click"
    assert 0.0 <= action["confidence"] <= 1.0


def test_scaled_screenshot_normalized_math(vision_service):
    from backend.app.services.vision.grounding import normalize_target

    target = {
        "bbox": {"x": 760, "y": 570, "width": 165, "height": 84},
        "normalized": {"x": 760 / 1280, "y": 570 / 720, "width": 165 / 1280, "height": 84 / 720},
        "point": {"x": 842, "y": 612},
    }
    out = normalize_target(target, 1280, 720)
    assert out is not None
    assert out["point"] == {"x": 842, "y": 612}
    assert out["normalized"] == {"x": round(760 / 1280, 4), "y": round(570 / 720, 4), "width": round(165 / 1280, 4), "height": round(84 / 720, 4)}


def test_e2e_redacted_submit_is_blocked_not_hallucinated(vision_service):
    redacted_button = (
        '{"actions": [{"type": "click", "target": {"bbox": {"x": 400, "y": 300, "width": 165, "height": 84}, '
        '"normalized": {"x": 0.625, "y": 0.625, "width": 0.258, "height": 0.175}, "point": {"x": 482, "y": 342}}, '
        '"confidence": 0.99}], "reason": "button", "completion": true}'
    )
    vision_service._content = redacted_button
    overlapped = body()
    overlapped["redaction_manifest"] = manifest(
        [{"id": "r1", "type": "PASSWORD", "method": "BLACKOUT", "bbox": [400, 300, 165, 84]}]
    )
    resp = client.post("/vision_step", json=overlapped)
    data = resp.json()
    assert data["status"] == "blocked_by_privacy"
    assert data["actions"] == []
    assert data["completion"] is False
