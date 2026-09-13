# VISUAL-REDACTION.md — Phase 3 Visual Privacy / Redaction Engine

> The redaction system is a **security boundary**, not a UI feature.
> Invariant: `RAW IMAGE ≠ TRANSMISSIBLE IMAGE`. Only a verified
> sanitized image plus a valid redaction manifest may reach an outbound
> sender, and only through the transmission gate.

---

## 1. Architecture

```
RAW SCREENSHOT (captureActiveTab)
        ↓
SensitiveRegion[] (Phase 2: vision + DOM + OCR + text fusion)
        ↓
Redaction Planner (redaction-planner.ts)
        ↓
RedactionOperation[]  ──┬──► Pixel Renderer (redaction-render.ts)
                        │         ↓
                        │    Sanitized RGBA buffer
                        │         ↓
                        └──► Manifest Builder (redaction-manifest.ts)
                                  ↓ (same ops — divergence impossible)
                        Pixel Verification (pixel-verify.ts)
                                  ↓
                        SanitizedImage (sealed artifact)
                                  ↓
                        Transmission Gate (image-gate.ts)
                                  ↓  ALLOW only
POST /api/agent/vision {image: png data-url, manifest} → server validates again
```

**RAW IMAGE → NEVER SEND. SANITIZED IMAGE + REDACTION MANIFEST → MAY SEND.**

---

## 2. Redaction methods (`redaction-policy.ts`)

Closed union: `BLACKOUT | BLUR | MASK`. Arbitrary strings cannot enter
the pipeline (`isRedactionMethod` guards every boundary).

| Method | Pixel behavior | Used for |
|---|---|---|
| `BLACKOUT` | Deterministic opaque fill (`blackoutColor`, default black) | HIGH identity: PASSWORD, CARD_NUMBER, AADHAAR, PAN, SSN, PASSPORT, VOTER_ID, DRIVING_LICENSE |
| `BLUR` | Box blur, radius 12, expanded edge-clamped sampling | FACE (presence-hiding; see limitations) |
| `MASK` | Deterministic opaque hatch pattern | Contact identifiers: UPI, IFSC, PHONE, EMAIL |

Strength ordering `BLACKOUT(3) > MASK(2) > BLUR(1)`: on overlap the
stronger method wins. The planner **upgrades** insecure combinations —
a custom policy mapping HIGH identity to BLUR resolves to BLACKOUT;
HIGH contact info to BLUR resolves to at least MASK.

---

## 3. Planner (`redaction-planner.ts`)

Pure function `(regions, image, policy) → {operations, dropped}`:

1. filter by per-type `minConfidence` (default 0.5),
2. resolve method via policy (floor enforced),
3. pad (FACE +12px, HIGH identity +8px, contact +6px — detector boxes
   may undershoot the true content; padding favors safety, stays small
   to preserve task UI),
4. clamp to integer sanitized-image pixels; drop zero-area /
   fully-out-of-frame boxes **with a recorded reason** (off-frame means
   no pixels exist to leak),
5. greedily merge intersecting boxes into their union (stronger method
   wins; all folded types retained in `mergedTypes`),
6. deterministic ids `r1..rn` in strength → severity → confidence order.

---

## 4. Coordinate system

One system end to end: **sanitized-image pixels**. Phase 2 regions are
canonical captured-image-relative; the planner pads + clamps them into
`[x, y, w, h]` integers with `0 ≤ x < width`, `0 ≤ y < height`. The
renderer re-clamps defensively. No screen/viewport/DOM/panel mixing —
conversion happens once, in the planner.

---

## 5. Pixel renderer (`redaction-render.ts`)

Copy-on-write RGBA surgery (source never mutated; works identically in
content script, worker, panel, node — no canvas/DOM dependency):

- BLACKOUT/MASK paint opaque pixels (originals cease to exist).
- BLUR is a real box blur over an expanded window sampled from the
  original buffer; the transmitted image contains blurred pixels (no
  CSS-overlay tricks anywhere in the pipeline).

---

## 6. Manifest protocol (`redaction-manifest.ts`)

```json
{"version": "1", "regions": [{"id": "r1", "type": "FACE", "method": "BLUR", "bbox": [100, 80, 120, 120]}]}
```

Built **only** from the renderer's applied operations. Validator
(`validateRedactionManifest`) rejects: wrong version, bad ids
(`rN`), unknown types, unsupported methods, non-integer/negative/
zero-size/out-of-image boxes, duplicate ids, oversized counts.
Wire format: `POST /api/agent/vision` with
`{"image": "data:image/png;base64,…", "manifest": {…}}`.
Backward compatibility: version gate — unknown versions are rejected,
never coerced. Server behavior on invalid manifest: HTTP 422.

---

## 7. Pixel verification (`pixel-verify.ts`)

- BLACKOUT: every box pixel exactly equals the fill.
- MASK: every box pixel exactly equals the deterministic pattern **and**
  no pixel retains its original value.
- BLUR: on non-uniform regions ≥5% pixels changed **and** variance
  reduced; uniform regions pass with a recorded note (nothing to
  reconstruct).
- Global: dimensions match; **every pixel outside all boxes is
  byte-identical** (task-UI preservation verified); manifest regions
  match applied ops exactly (declared == actual).
- Any failure → `SanitizeError`, no artifact escapes (fail closed).

No claim of information-theoretic irreversibility is made — this is
robust engineering verification that the pipeline did what it declared.

---

## 8. Sanitized image artifact (`sanitized-image.ts`)

`RawCapture` and `SanitizedImage` are **different types** — no
`isSanitized` boolean exists. `SanitizedImage` instances are sealed in
a module-private registry at creation; the gate accepts only live
sealed instances (forgery impossible from outside the module).
Both own their buffers; `dispose()` zero-fills and unseals (the gate
refuses disposed artifacts). PNG export is deterministic
(`png.ts`, stored-block DEFLATE — byte-exact, decodable everywhere).

---

## 9. Transmission gate (`image-gate.ts`)

`ImageTransmissionGate.sendSanitized(image, manifest?)` — the **only**
sanctioned image sender. Fail-closed checklist, enforced in code:

1. sealed + live `SanitizedImage`, else BLOCK (`NOT_SANITIZED_ARTIFACT` / `DISPOSED_ARTIFACT`) **without touching the network**,
2. manifest present + valid (`MISSING/INVALID_MANIFEST`),
3. pixel verification passed (`UNVERIFIED_IMAGE`),
4. presented manifest deep-equals sealed manifest (`MANIFEST_MISMATCH`),
5. POST; non-2xx/transport error → BLOCK (`UPSTREAM_REJECTED` / `TRANSPORT_ERROR`).

There is no `sendRaw` escape hatch. Bypass prevention in depth:

- `background/router.ts` drops any extension message carrying probable
  image bytes (`containsImagePayload`) before relay,
- `tests/extension/privacy/image-transmission-audit.test.ts` fails on
  any new unreviewed network sink (fetch/WebSocket/XHR/FormData/Beacon),
- the text path (`GatewayLlmProvider` → `/api/agent/step`) keeps its
  `TransmissionFirewall` (blocks `RAW_IMAGE`) and the backend schema
  (`extra="forbid"`) 422s smuggled image fields.

---

## 10. Fail-closed behavior

Vision unavailable / regions untrusted / render throws / verification
fails / manifest invalid / artifact disposed / gate error / upstream
non-2xx → **BLOCK**. The system never falls back to sending raw.

---

## 11. Backend defense-in-depth (`backend/app/privacy/image_manifest.py`, `backend/app/api/vision.py`)

Re-validates manifest + PNG envelope + manifest↔image dimensions
(decoded from the IHDR header), then **discards the bytes** (receipt
only, never stored). Failures → 422. Client-side blocking remains
mandatory regardless.

---

## 12. Logging / memory

Logs carry region counts, types, methods, verification results,
latencies, manifest version — never pixels, base64, OCR text, or
identifiers. Raw buffers are disposed after sanitizing; worker raster
transfer is zero-copy (sender side neutered); panel keeps only the
display data-URL in view state.

---

## 13. Test methodology

- Unit: policy, planner (clamp/pad/overlap/ids), renderer (all three
  methods, determinism, copy-on-write), manifest (build + validator +
  substitution), verifier (pass + tamper/skip/dimension/manifest-mismatch
  failures), artifact (seal, forgery, disposal), gate (12 bypass
  vectors), static transmission audit.
- Pixel acceptance: all 9 Phase-2 fixtures — sensitive boxes
  transformed, surroundings byte-identical, changed-% measured.
- UI preservation regressions: login + checkout scenes (sensitive
  redacted, button/merchant/amount byte-identical).
- **AT-03**: 10 raw-shaped attempts → BLOCK, **0 fetch calls**.
- **AT-04**: GT regions → sanitize → verify → gate ALLOW on
  card-checkout + pwd-login; wire bytes decoded and pixel-compared
  (sensitive gone, UI intact).

---

## 14. Performance (measured, 640×480, n=15)

| workload | total median | total p95 | plan p95 | verify p95 |
|---|---|---|---|---|
| few (3 ops) | 2.56 ms | 5.31 ms | 0.06 ms | 4.99 ms |
| many (48 ops) | 3.02 ms | 7.21 ms | 0.16 ms | 6.13 ms |

Full-boundary on fixtures (sanitize incl. PNG-less path): ~2–8 ms;
AT-04 wire payloads ~1.6 MB (stored-block PNG — size/compression
tradeoff documented below).

---

## 15. Known limitations (honest)

- **BLUR ≠ erasure.** FACE blur hides presence at a glance; a
  motivated adversary with priors may infer coarse attributes. Policy
  default keeps BLUR for faces (utility), BLACKOUT for identifiers.
- **PNG size.** The deterministic encoder uses stored DEFLATE blocks
  (correctness first): 640×480 sanitized PNGs are ~1.2 MB on the wire.
  A streaming compressor can replace it later without changing the
  protocol (bytes stay PNG).
- **Detector coverage bounds redaction.** The boundary redacts what
  Phase 2 reports; FACE is NOT TESTED with real subjects and masked
  values need OCR (both declared in Phase 2). Unknown sensitive content
  the detector misses is not redacted — the gate cannot prove a
  negative.
- **In-renderer trust.** The seal registry stops cross-module forgery,
  not a compromised renderer itself; supply-chain integrity of
  `extension/src/privacy/*` is assumed (same trust as the firewall).
- **Server stores nothing** by design; there is no server-side image
  audit trail — receipts only.
