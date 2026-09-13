# POST /vision_step — Visual Grounding Endpoint (Phase 5)

> Sanitized visual context in, strictly typed visual actions out.
> The endpoint receives **sanitized** images through the intended
> production flow and never executes raw model output.

## Purpose

Connect TrusTech's client-side visual context (Phase 4 pipeline) to
backend VLM reasoning and return typed actions the existing browser
executor consumes: visual input → understand UI → identify target →
structured action → grounding data.

## Authentication

Same as all protected routes: gateway bearer token
(`TRUSTECH_GATEWAY_TOKEN`) via `require_gateway_token`. No key apart
from the model key (server env only) is involved.

## Request schema

`VisionStepRequest`: `{task, visual_context, redaction_manifest,
vision_metadata}` (all required, `extra="forbid"`).

- `task`: `{goal (1..2000 chars), intent?, subtask?}` — grounding-only
  context, no credentials or PII.
- `visual_context`: `{image: data:image/png;base64,…, width, height}`
  — sanitized PNG; declared dims must equal decoded dims.
- `redaction_manifest`: `{version: "1", regions: [{id: rN, type,
  method: BLACKOUT|BLUR|MASK, bbox: [x,y,w,h]}]}` — unique ids,
  boxes inside the image. Bboxes are **sanitized-image pixels**.
- `vision_metadata`: `{model, model_version, runtime:
  "browser-local", backend: webgpu|wasm|cpu, inference_latency_ms,
  detections, capture_width, capture_height}` — no pixels, no text.

Limits: image ≤ 8 MB / ≤ 8192px per side; ≤ 500 regions; VLM call
bounded at 30s provider timeout inside a 50s chain budget.

## Response schema

`VisionStepResponse`: `{actions: [{type: "click", target: {bbox,
normalized, point}, confidence: 0..1}] (max 3), reason (≤300 chars),
completion: bool, status, model, redacted_regions}`.

`status`: `success | target_not_found | blocked_by_privacy |
low_confidence | invalid_model_output | error`.

- `bbox`/`point`: image pixels. `normalized`: 0..1 relative to image
  dims (`normalized.x = pixelX / imageWidth`). The browser converts
  normalized → image px → viewport px (`/ devicePixelRatio` mapping for
  visible-tab captures) and grounds via `elementFromPoint` +
  the existing grounder — coordinates never execute directly.
- Actions below 0.7 confidence are withheld (`low_confidence`).
- Targets inside (or ≥5% IoU with) a redacted region are withheld
  (`blocked_by_privacy`). Confidence never equals permission.

## Failure states

422 malformed request/manifest/image/dims; 503 no vision provider;
504 VLM timeout; 502 unusable model output → structured
`invalid_model_output` (never fake actions, invented coordinates, or
false completion).

## VLM behavior

Gemini `generateContent` with `inline_data` PNG + a JSON-only grounding
prompt that includes the redaction manifest and forbids targeting,
describing, or inferring redacted content. Provider failures map to
the existing `AIErrorCategory` taxonomy. No vision provider → 503.

## Privacy

Request bytes are validated, grounded, and discarded — images are
never stored, logged, or dumped (logs: status, dims, region/action
counts, latencies). Server validation is defense-in-depth; the browser
pipeline remains responsible for never sending raw images.

## Examples

Success, target-not-found, privacy-block, and low-confidence shapes
are specified in the Phase 5 report §36 and pinned by
`backend/tests/test_vision_step.py` and
`tests/extension/vision/vision-step-response.test.ts`.
