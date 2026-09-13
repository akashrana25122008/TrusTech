"""Server-side defense-in-depth for the sanitized-image protocol.

The client-side privacy boundary (redact → verify → manifest → gate) is
mandatory and happens BEFORE any byte leaves the browser. This module is
the second lock: the server independently validates the redaction
manifest and the PNG envelope, and rejects anything malformed with 422.

The server NEVER sanitizes raw images, NEVER stores screenshot bytes,
and NEVER accepts an image without a valid manifest.

Protocol (client → POST /api/agent/vision):
    {"image": "data:image/png;base64,…", "manifest": {"version": "1", "regions": […] Counter}}
Manifest region: {"id": "r1", "type": "FACE", "method": "BLUR",
                  "bbox": [x, y, w, h]} in sanitized-image pixel coords.
"""

from __future__ import annotations

import base64
import binascii
import re
from typing import Any

MANIFEST_VERSION = "1"
METHODS = frozenset({"BLACKOUT", "BLUR", "MASK"})
TYPES = frozenset(
    {
        "FACE",
        "PASSWORD",
        "CARD_NUMBER",
        "AADHAAR",
        "PAN",
        "UPI",
        "IFSC",
        "PHONE",
        "EMAIL",
        "PASSPORT",
        "VOTER_ID",
        "DRIVING_LICENSE",
        "SSN",
    }
)
ID_RE = re.compile(r"^r[1-9][0-9]*$")
DATA_URL_RE = re.compile(r"^data:image/png;base64,([A-Za-z0-9+/=\s]+)$")

MAX_REGIONS = 500
MAX_IMAGE_BYTES = 8 * 1024 * 1024
MAX_DIMENSION = 8192
PNG_SIGNATURE = bytes([137, 80, 78, 71, 13, 10, 26, 10])


def validate_manifest(manifest: Any) -> list[str]:
    """Return a list of validation errors (empty == valid)."""
    if not isinstance(manifest, dict):
        return ["manifest must be an object"]
    if manifest.get("version") != MANIFEST_VERSION:
        return [f"unsupported manifest version: {manifest.get('version')!r}"]
    regions = manifest.get("regions")
    if not isinstance(regions, list):
        return ["manifest.regions must be an array"]
    if len(regions) > MAX_REGIONS:
        return [f"too many regions ({len(regions)} > {MAX_REGIONS})"]
    errors: list[str] = []
    seen: set[str] = set()
    for i, entry in enumerate(regions):
        where = f"regions[{i}]"
        if not isinstance(entry, dict):
            errors.append(f"{where} must be an object")
            continue
        rid = entry.get("id")
        if not isinstance(rid, str) or not ID_RE.match(rid):
            errors.append(f"{where}.id must match rN")
        elif rid in seen:
            errors.append(f"{where}.id duplicates {rid}")
        else:
            seen.add(rid)
        if entry.get("type") not in TYPES:
            errors.append(f"{where}.type unknown: {entry.get('type')!r}")
        if entry.get("method") not in METHODS:
            errors.append(f"{where}.method unsupported: {entry.get('method')!r}")
        bbox = entry.get("bbox")
        if (
            not isinstance(bbox, list)
            or len(bbox) != 4
            or any(not isinstance(v, int) or isinstance(v, bool) or v < 0 or v > MAX_DIMENSION for v in bbox)
        ):
            errors.append(f"{where}.bbox must be [x,y,w,h] non-negative integers")
        elif bbox[2] <= 0 or bbox[3] <= 0:
            errors.append(f"{where}.bbox must have positive size")
    return errors


def decode_png_data_url(value: Any) -> tuple[bytes | None, str | None]:
    """Return (png_bytes, None) or (None, error). Never raises."""
    if not isinstance(value, str):
        return None, "image must be a string"
    match = DATA_URL_RE.match(value.strip())
    if not match:
        return None, "image must be a data:image/png;base64,… URL"
    try:
        raw = base64.b64decode(match.group(1), validate=True)
    except (binascii.Error, ValueError):
        return None, "image base64 is malformed"
    if len(raw) > MAX_IMAGE_BYTES:
        return None, f"image too large ({len(raw)} > {MAX_IMAGE_BYTES})"
    if len(raw) < 33 or raw[:8] != PNG_SIGNATURE:
        return None, "image is not a PNG"
    return raw, None


def png_dimensions(png: bytes) -> tuple[int | None, int | None]:
    """Parse width/height from the IHDR chunk. (None, None) if unreadable."""
    try:
        if png[12:16] != b"IHDR":
            return None, None
        width = int.from_bytes(png[16:20], "big")
        height = int.from_bytes(png[20:24], "big")
        if not (0 < width <= MAX_DIMENSION and 0 < height <= MAX_DIMENSION):
            return None, None
        return width, height
    except IndexError:
        return None, None


def manifest_fits_image(manifest: dict, width: int, height: int) -> list[str]:
    """Every manifest box must lie inside the decoded image dimensions."""
    errors: list[str] = []
    for i, entry in enumerate(manifest.get("regions", [])):
        bbox = entry.get("bbox")
        if not isinstance(bbox, list) or len(bbox) != 4:
            continue
        x, y, w, h = bbox
        if not all(isinstance(v, int) for v in (x, y, w, h)):
            continue
        if x >= width or y >= height or x + w > width or y + h > height:
            errors.append(f"regions[{i}].bbox extends outside {width}x{height} image")
    return errors


KNOWN_MODELS = frozenset({"yolos-tiny"})
KNOWN_BACKENDS = frozenset({"webgpu", "wasm", "cpu"})
METADATA_KEYS = frozenset(
    {
        "model",
        "model_version",
        "runtime",
        "backend",
        "inference_latency_ms",
        "detections",
        "capture_width",
        "capture_height",
    }
)


def validate_vision_metadata(metadata: Any) -> list[str]:
    """Strict vision-metadata validation. Unknown keys are rejected so a
    metadata object can never smuggle page-derived strings."""
    if not isinstance(metadata, dict):
        return ["metadata must be an object"]
    errors: list[str] = []
    for key in metadata:
        if key not in METADATA_KEYS:
            errors.append(f"unknown metadata key: {key}")
    if metadata.get("model") not in KNOWN_MODELS:
        errors.append(f"unknown model: {metadata.get('model')!r}")
    version = metadata.get("model_version")
    if not isinstance(version, str) or not (0 < len(version) <= 32):
        errors.append("model_version must be a short string")
    if metadata.get("runtime") != "browser-local":
        errors.append("runtime must be browser-local")
    if metadata.get("backend") not in KNOWN_BACKENDS:
        errors.append(f"unknown backend: {metadata.get('backend')!r}")
    latency = metadata.get("inference_latency_ms")
    if not isinstance(latency, (int, float)) or isinstance(latency, bool) or not (0 <= latency <= 600_000):
        errors.append("inference_latency_ms out of range")
    for key, lo, hi in (("detections", 0, 10_000), ("capture_width", 1, 8192), ("capture_height", 1, 8192)):
        value = metadata.get(key)
        if not isinstance(value, int) or isinstance(value, bool) or not (lo <= value <= hi):
            errors.append(f"{key} out of range")
    return errors
