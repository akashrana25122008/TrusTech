# TrusTech Metrics

> Generated from actual benchmark execution. Do not hand-edit values below:
> re-run `npm run metrics`. Timestamp: 2026-09-13T14:56:09.313Z · commit: 3de7562.

## 1. Executive summary

| Metric | Result | Weight | Notes |
| --- | ---: | ---: | --- |
| Visual-context accuracy | 100.0% | 25% | Measured, 15 fixtures |
| PII precision | 100.0% | 20% (as F1 100.0%) | Measured, 29 texts |
| PII recall | 100.0% | — (folded into F1) | Measured |
| Redaction precision | 100.0% | 20% | Measured, 10 boxes |
| Client resources | peak RSS Δ 81.25 MB | 20% (budget-normalized) | Measured; CPU NOT_MEASURED |
| Median E2E latency | 0.74 ms | 15% (budget-normalized) | Measured, n=10 |
| **Weighted score** | **96.7%** | 100% | MEASURED |

## 2. Environment

- Node v26.0.0 · darwin-arm64
- Commit 3de7562 · 2026-09-13T14:56:09.313Z

## 3. Datasets

- Vision grounding: `tests/metrics/fixtures/vision.json` (15 fixtures: navbar, form, search, select, video, modal, cards, list, disabled, partial-edge, nested, duplicates, overlay, stale, DPR-2).
- PII: `tests/metrics/fixtures/pii.json` v1 (29 clear + 3 ambiguous; generator `generate-pii.mjs`).
- Redaction: `tests/metrics/fixtures/redaction.json` v1 (7 scenes).

## 4. Methodology

- Vision accuracy = proposals resolved to the intended element (or documented failure code) / all proposals. Real-model line is informational (no GT boxes exist): known-target presence on sample-cats.png.
- PII: same type + char-span IoU ≥ 0.5. Headline over CLEAR items; AMBIGUOUS shapes (invalid-checksum Aadhaar, dotless UPI-shaped handle) measured separately by engine-design intent.
- Redaction: recall = GT boxes ≥95% covered / all; precision = ops covering ≥95% of ≥1 GT box / all ops; over-redaction = op area > 3× covered GT union.
- Latency: 2 discarded iterations per stage; high-resolution timers; E2E = time from visual-planner call start to validated action (stub capture, real inference/sanitize/permit/verify/grounding, mock VLM transport).
- Resources: in-process RSS sampling (GC caveat applies); payload bytes by encoding; request counts from mock transports.

## 5. Results

### Vision grounding: 100.0% (15/15), Wilson 95% [79.6%, 100.0%]

Model line: 2/2 cats, 2 detections, inference 1788.17 ms (MEASURED).

### PII: precision 100.0%, recall 100.0%, F1 100.0% (TP 18 / FP 0 / FN 0)

| Category | TP/FP/FN | Precision | Recall | Samples |
| --- | --- | ---: | ---: | ---: |
| aadhaar | 1/0/0 | 100.0% | 100.0% | 1 |
| credit_card | 3/0/0 | 100.0% | 100.0% | 3 |
| driving_licence | 1/0/0 | 100.0% | 100.0% | 1 |
| email | 2/0/0 | 100.0% | 100.0% | 2 |
| ifsc | 1/0/0 | 100.0% | 100.0% | 1 |
| ipv4 | 1/0/0 | 100.0% | 100.0% | 1 |
| pan | 1/0/0 | 100.0% | 100.0% | 1 |
| passport | 1/0/0 | 100.0% | 100.0% | 1 |
| phone | 3/0/0 | 100.0% | 100.0% | 3 |
| postal | 1/0/0 | 100.0% | 100.0% | 1 |
| ssn | 1/0/0 | 100.0% | 100.0% | 1 |
| upi | 1/0/0 | 100.0% | 100.0% | 1 |
| voter_id | 1/0/0 | 100.0% | 100.0% | 1 |

Ambiguous shapes tracked separately (3 items, all emit weak findings by design — see fragment-pii-ambiguous.json).

### Redaction: precision 100.0%, recall 100.0% (10/10 boxes, 7 ops, 0 over-redacted)

## 6. Failure analysis

None. Zero failed fixtures across vision grounding, PII and redaction; zero over-redacted ops.

## 7. Latency (measured, failures included in counts)

| Stage | n | Median | p95 | Max | Failures |
| --- | ---: | ---: | ---: | ---: | ---: |
| vision/inference | 5 | 1201 ms | 1247 ms | 1257 ms | 0 |
| sanitization | 15 | 2.83 ms | 4.22 ms | 4.81 ms | 0 |
| transmission | 15 | 53 ms | 64 ms | 67 ms | 0 |
| grounding | 50 | 0.10 ms | 0.22 ms | 0.27 ms | 0 |
| execution | 50 | 0.09 ms | 0.12 ms | 0.15 ms | 0 |
| verification | 15 | 2.38 ms | 2.83 ms | 2.92 ms | 0 |
| end-to-end | 10 | 0.74 ms | 0.82 ms | 0.82 ms | 0 |

## 8. Resources (measured)

- RSS: baseline 75.83 MB, peak 157.08 MB, Δ 81.25 MB.
- CPU: NOT_MEASURED — no reliable CPU API in this runtime.
- Sanitized PNG payloads: 640×480 scenes range 1229438–1229438 bytes.
- Requests: 3 mock transmissions observed in this run; blocking paths assert 0 requests (AT-03/AT-05).

## 9. Weighted score: 96.7%

- accuracy/precision/recall/F1 enter as 0..1 (higher is better).
- resourceScore = max(0, 1 - peakRssDeltaMb/500): 500 MB is a stated generous client bound, not a product claim.
- latencyScore = max(0, 1 - e2eMedianMs/30000): 30 s is the stated task budget matching provider timeouts.
- Formulas are budget-based and documented here; they were not tuned to maximize the score.

## 10. Limitations

- Model box-level accuracy: INSUFFICIENT DATA (no GT boxes for photos).
- API-key/token PII findings: INSUFFICIENT DATA (no detector support; secrets firewall covers blocking, unmeasured here).
- Backend VLM latency: NOT_MEASURED (no live provider key).
- CPU: NOT_MEASURED. RSS is GC-sensitive; treat deltas as approximate.
- Latency/VLM behavior varies by machine, model and network; this report is one environment snapshot.
- Candidate regression floors (not enforced): vision accuracy ≥ 90%, PII recall = 100% on the clear corpus, redaction precision = 100%, e2e p95 < 5 s. These are proposals, not gates.

## 11. Reproduction

```
npm run metrics
```

Runs `vitest run tests/metrics`, writes `tests/metrics/reports/fragment-*.json`, then generates `results.json` + this file. Re-running changes values only when measurements change (accuracy fixtures are deterministic; latencies naturally vary). Fragments are per-suite files so parallel workers never race. Full product suite stays separate: `npm test`.
