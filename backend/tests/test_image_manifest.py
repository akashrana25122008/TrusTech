"""Phase 3 server-side defense-in-depth: manifest validator + /api/agent/vision intake."""

import base64
import struct
import zlib

from fastapi.testclient import TestClient

from backend.app.main import app
from backend.app.privacy.image_manifest import (
    decode_png_data_url,
    manifest_fits_image,
    png_dimensions,
    validate_manifest,
)

client = TestClient(app)


def tiny_png(width=64, height=48, color=(10, 20, 30, 255)):
    raw = b"".join(b"\x00" + bytes(color) * width for _ in range(height))
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)

    def chunk(typ, data):
        c = struct.pack(">I", len(data)) + typ + data
        return c + struct.pack(">I", zlib.crc32(typ + data) & 0xFFFFFFFF)

    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )
    return "data:image/png;base64," + base64.b64encode(png).decode()


def manifest():
    return {
        "version": "1",
        "regions": [{"id": "r1", "type": "PASSWORD", "method": "BLACKOUT", "bbox": [4, 4, 16, 8]}],
    }


# ---------------- validator unit tests ----------------


def test_valid_manifest_passes():
    assert validate_manifest(manifest()) == []


def test_bad_version_rejected():
    assert validate_manifest({"version": "2", "regions": []})


def test_duplicate_ids_rejected():
    m = manifest()
    m["regions"].append({"id": "r1", "type": "PAN", "method": "BLACKOUT", "bbox": [0, 0, 4, 4]})
    assert validate_manifest(m)


def test_unknown_method_rejected():
    m = manifest()
    m["regions"][0]["method"] = "ERASE"
    assert validate_manifest(m)


def test_non_integer_bbox_rejected():
    m = manifest()
    m["regions"][0]["bbox"] = [0.5, 0, 4, 4]
    assert validate_manifest(m)


def test_non_png_data_url_rejected():
    assert decode_png_data_url("data:image/jpeg;base64,AAAA")[1]
    assert decode_png_data_url("not-a-url")[1]
    assert decode_png_data_url(None)[1]


def test_png_dimensions_parsed():
    png, err = decode_png_data_url(tiny_png(64, 48))
    assert err is None
    assert png_dimensions(png) == (64, 48)


def test_manifest_outside_image_rejected():
    m = manifest()
    m["regions"][0]["bbox"] = [60, 44, 50, 50]
    assert manifest_fits_image(m, 64, 48)


# ---------------- route tests ----------------


def test_valid_intake_accepted_and_bytes_discarded():
    resp = client.post("/api/agent/vision", json={"image": tiny_png(), "manifest": manifest()})
    assert resp.status_code == 200
    body = resp.json()
    assert body["received"] is True
    assert body["regions"] == 1
    assert body["image"] == {"width": 64, "height": 48, "bytes": len(__import__("base64").b64decode(tiny_png().split(",")[1]))}
    assert "image" not in str(body.get("stored", "none"))


def test_bad_manifest_version_422():
    m = manifest()
    m["version"] = "99"
    resp = client.post("/api/agent/vision", json={"image": tiny_png(), "manifest": m})
    assert resp.status_code == 422


def test_missing_manifest_422():
    resp = client.post("/api/agent/vision", json={"image": tiny_png()})
    assert resp.status_code == 422


def test_non_png_image_422():
    resp = client.post("/api/agent/vision", json={"image": "data:image/png;base64,!!!!", "manifest": manifest()})
    assert resp.status_code == 422


def test_manifest_image_mismatch_422():
    m = manifest()
    m["regions"][0]["bbox"] = [60, 44, 50, 50]  # outside the 64x48 frame
    resp = client.post("/api/agent/vision", json={"image": tiny_png(), "manifest": m})
    assert resp.status_code == 422


def test_raw_screenshot_field_rejected_422():
    # A raw screenshot smuggled as an unknown field is rejected by schema.
    resp = client.post(
        "/api/agent/vision",
        json={"image": tiny_png(), "manifest": manifest(), "screenshot": "data:image/png;base64,AAAA"},
    )
    assert resp.status_code == 422


# ---------------- Phase 4 full contract ----------------

from backend.app.privacy.image_manifest import validate_vision_metadata


def full_payload(**over):
    body = {
        "task": {"goal": "pay the electricity bill", "intent": "payment"},
        "visual_context": {"image": tiny_png(), "width": 64, "height": 48},
        "redaction_manifest": manifest(),
        "vision_metadata": {
            "model": "yolos-tiny",
            "model_version": "q8",
            "runtime": "browser-local",
            "backend": "cpu",
            "inference_latency_ms": 41.5,
            "detections": 2,
            "capture_width": 64,
            "capture_height": 48,
        },
    }
    body.update(over)
    return body


def test_full_contract_accepted():
    resp = client.post("/api/agent/vision", json=full_payload())
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["received"] is True
    assert body["regions"] == 1
    assert body["image"]["width"] == 64
    assert body["declared"] == {"width": 64, "height": 48}


def test_full_contract_missing_metadata_422():
    body = full_payload()
    del body["vision_metadata"]
    assert client.post("/api/agent/vision", json=body).status_code == 422


def test_full_contract_smuggled_metadata_key_422():
    body = full_payload()
    body["vision_metadata"]["ocr_text"] = "4111 1111 1111 1111"
    assert client.post("/api/agent/vision", json=body).status_code == 422


def test_full_contract_dimension_mismatch_422():
    body = full_payload()
    body["visual_context"]["width"] = 640  # PNG is 64 wide
    assert client.post("/api/agent/vision", json=body).status_code == 422


def test_full_contract_bad_manifest_422():
    body = full_payload()
    body["redaction_manifest"]["version"] = "9"
    assert client.post("/api/agent/vision", json=body).status_code == 422


def test_full_contract_unknown_shape_422():
    assert client.post("/api/agent/vision", json={"foo": 1}).status_code == 422


def test_metadata_validator_unit():
    good = full_payload()["vision_metadata"]
    assert validate_vision_metadata(good) == []
    bad = {**good, "runtime": "cloud-gpu", "extra": 1}
    errors = validate_vision_metadata(bad)
    assert any("runtime" in e for e in errors)
    assert any("extra" in e for e in errors)
