# VISUAL-TRANSMISSION.md — Phase 4 Visual Transmission Protocol

> End-to-end pipeline from capture to HTTPS, gated by the Phase 3
> privacy boundary. Invariant: **RAW IMAGE → NEVER SEND.** Only a
> verified sanitized image plus a valid manifest plus valid vision
> metadata plus a passed privacy gate may reach the network layer.

---

## 1. End-to-end architecture

```
CAPTURE (vision/capture.ts)
  ↓
VISION (worker, YOLOS-tiny, browser-local)
  ↓
PII (Phase 2 analyzer → SensitiveRegion[])
  ↓
REDACTION (planner → BLACKOUT/BLUR/MASK renderer)
  ↓
PIXEL VERIFICATION (pixel-verify.ts)
  ↓
SanitizedImage (sealed artifact)
  ↓
PRIVACY GATE: authorizeVisualTransmission → TransmissionPermit
  ↓
ENCODE sanitized artifact (deterministic PNG)
  ↓
HTTPS POST {task, visual_context, redaction_manifest, vision_metadata}
  ↓
BACKEND /api/agent/vision (re-validate → discard bytes)
```

---

## 2. Transmission API (`privacy/visual-transmission.ts`)

One authoritative sender: `transmitVisualContext({permit, image,
metadata, task, transport, …})`. It accepts **no raw shapes** —
`RawCapture`, `ImageBitmap`, `Blob`, `ArrayBuffer`, base64 strings are
compile-time strangers and runtime `NOT_SANITIZED_ARTIFACT` BLOCKs.
There is no `sendImage(x, isSanitized)` boolean anywhere.

The sender requires a **live `TransmissionPermit`** and revalidates it
against the current bytes on **every** attempt (initial + retries).

Lower-level `ImageTransmissionGate.sendSanitized` (Phase 3) remains as
the artifact-level sender; the pipeline sender is the permit-bound API
above it. No competing boundaries — one validates artifacts, the other
authorizes pipeline transmissions.

---

## 3. Payload schema (§4 contract)

```json
{
  "task": {"goal": "…", "intent": "…"},
  "visual_context": {"image": "data:image/png;base64,…", "width": 1280, "height": 720},
  "redaction_manifest": {"version": "1", "regions": [{"id": "r1", "type": "FACE", "method": "BLUR", "bbox": [100, 80, 120, 120]}]},
  "vision_metadata": {"model": "yolos-tiny", "model_version": "q8", "runtime": "browser-local", "backend": "webgpu", "inference_latency_ms": 42, "detections": 5, "capture_width": 1280, "capture_height": 720}
}
```

Validated client-side (`validateVisualPayload`) before encoding, and
server-side again. Unknown top-level keys are rejected on both ends.

---

## 4. Image encoding

Deterministic PNG (`privacy/png.ts`, stored DEFLATE blocks —
byte-exact, decodable everywhere). The encoder receives **only** the
sealed artifact (`image.pngBytes()`); there is no code path that
encodes a raw capture. Wire PNGs are ~1.2 MB at 640×480 (stored blocks
favor correctness over size; compression can replace the DEFLATE layer
later without changing the protocol).

---

## 5. Manifest protocol

Phase 3 manifest, transmitted verbatim. Built from applied operations
only; validated at plan time, gate time, and server time. Version
gated (`"1"`); unknown versions rejected, never coerced.

---

## 6. Vision metadata

Minimal and privacy-preserving: model id/version, `browser-local`
runtime, backend, inference latency, detection count, capture dims.
Strict schema — unknown keys (e.g. smuggled OCR text) are rejected.
Never carried: pixels, OCR plaintext, page strings.

---

## 7. Privacy permit (`privacy/transmission-permit.ts`)

`authorizeVisualTransmission({image, manifest?, metadata?})` binds
`sha-256(sanitized PNG)` + `sha-256(canonical manifest)` + 5-minute
expiry into a frozen, registry-sealed `TransmissionPermit`. A permit
for image A cannot authorize image B (sender re-hashes before every
POST). Expired permits, substituted manifests, and mutated bytes all
fail closed. Metadata is required by default.

---

## 8. HTTPS

`https:` required. `http:` is rejected unless **explicit local dev**:
`allowInsecureLocalhost: true` **and** loopback host (localhost /
127.0.0.1 / ::1). Production TLS is never weakened for tests — tests
use the injected mock transport, not plain HTTP.

---

## 9. Authentication

Reuses the gateway bearer token (`TRUSTECH_GATEWAY_TOKEN`,
`Authorization` header attached post-firewall). Tokens are never logged
and never embedded in visual payloads. No second auth mechanism.

---

## 10. Retries, queueing, abort/timeout

- **Retries** (`transmitWithRetry`): same sealed bytes (byte-identical
  bodies asserted in tests), permit revalidated per attempt; only
  transport-level failures retry — privacy verdicts never loop.
- **Queue** (`VisualTransmissionQueue`): accepts sealed artifact +
  live permit + manifest/metadata/task only; raw shapes rejected at
  enqueue; items that die in-queue report BLOCK at drain. Offline hold
  = sanitized artifacts only, never raw screenshots.
- **Abort/timeout**: `AbortSignal` + configurable timeout; user abort →
  `ABORTED`, budget expiry → `TIMEOUT`, 4xx/5xx → `UPSTREAM_REJECTED`.
  No failure falls back to raw — there is no raw path to fall back to.

---

## 11. Server validation (`backend/app/api/vision.py`)

Accepts the full §4 contract and the legacy flat `{image, manifest}`
shape (both validated identically). Checks: manifest schema, PNG
envelope + magic, IHDR dimensions vs `visual_context` dims, manifest
boxes inside decoded dims, metadata schema. Bytes are **discarded**
(receipt only, never stored). Failures → 422. Server validation is
defense-in-depth; the browser boundary remains mandatory.

---

## 12. Privacy telemetry

Value-free events: `TRANSMISSION_ALLOWED/BLOCKED`,
`VERIFICATION_FAILED`, `MANIFEST_INVALID`, `RAW_IMAGE_REJECTED`,
`UPSTREAM_REJECTED`, `TIMEOUT`, `ABORTED` — with region counts,
permit ids, and stage latencies. Never pixels, base64, OCR, or
identifiers. Debug shape:
`{"decision": "BLOCKED", "reason": "PIXEL_VERIFICATION_FAILED",
"regions": 4, "redaction_version": "1"}`.

---

## 13. Tests

- Contract: payload/metadata/task schema + smuggled-key rejection.
- Permit: issue, deterministic binding, forgery/disposal/substitution/
  expiry rejection, revalidation.
- Sender: exact §4 shape, HTTPS rules, tamper/expiry/upstream/timeout/
  abort BLOCKs, telemetry contents.
- Retry/queue: byte-identical retries, no privacy-verdict loops, raw
  enqueue rejection, dead-in-queue BLOCK.
- **AT-05**: 8 raw representations + forged permit → BLOCK, **0 requests**.
- **AT-06**: matrix A/B/C BLOCK with 0 requests, D ALLOW with 1 request.
- **AT-07**: real fixture PNG + real YOLOS inference → permit → mock
  HTTPS → 1 request; wire PNG pixel-compared (sensitive gone, UI kept).
- Byte proof: wire image == sealed sanitized pixels, ≠ raw capture.
- Static audit: 4 allowlisted senders; capture/vision never import
  senders; senders never capture; no `sendRaw` anywhere.
- Backend: 21 tests (validator + both shapes + mismatch/smuggle cases).

---

## 14. Performance (measured)

Full pipeline, 640×480 / 6 regions, n=10: sanitize median 11.06ms
(p95 16.77) · permit (2× sha-256 over ~1.2 MB) 11.80/15.28 · send
(encode+validate+mock post) 40.41/50.06 · **full 63.12/82.12** ·
text-only firewall baseline 0.09/1.68 → **boundary overhead ≈63ms
median**, dominated by PNG encode + hashing of stored-block PNGs.

---

## 15. Known limitations

- Permit TTL (5 min) is a policy constant, not negotiated with the server.
- Stored-block PNGs are large (~1.2 MB @640×480); compression is future work.
- Metadata trusts the local runtime clock for `issuedAt`/`expiresAt`.
- Live-browser run not verified here (jsdom + node coverage only).
- The boundary redacts what Phase 2 reports; detector limits carry over.
