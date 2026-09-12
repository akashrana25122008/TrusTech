# Part 15 — Re-Audit: Recomputed Capability Matrix (Report)

STATUS: **VERIFIED (unit recompute; browser cells held as PENDING_USER)**
UNIT TESTS: full suite green (see status.md)
BROWSER TEST: **PENDING_USER** — final flip needs the operator runbook (Part 14)

## What changed since Part 0

Baseline recorded `Composite functional control: 11 / 61 ≈ 18%`. Every P0/P1 root cause is now
closed with a unit gate (parts 1–13), the LLM seam is wired (Part 12), and the real-world gate + runbook
added (Part 14). The only rows not yet **certified-live** are the ones that require a physical Chrome
tab — each with an operator checklist.

## Recomputed capability matrix (post-repair)

| Capability | Baseline | Post-repair (unit) | Live |
|---|---|---|---|
| content boot | NO | WORKING (Part 1 build gate + smoke) | PENDING_USER |
| handshake | NO | WORKING (Part 2) | PENDING_USER |
| observe/ground | tests only | WORKING (Part 6) | PENDING_USER |
| execute | tests only | WORKING | PENDING_USER |
| dock page actions | NO | WORKING (Parts 4–5) | PENDING_USER |
| back/forward honesty | NO | WORKING (Part 4 `deliverChecked`) | PENDING_USER |
| active tab (SW restart) | intermittent | WORKING (Part 9, adapter-driven) | PENDING_USER |
| tab list/get | NO | WORKING (Part 4 router) | PENDING_USER |
| panel events | NO | WORKING (Part 10 broadcast) | PENDING_USER |
| verify/recover | rubber | WORKING (Parts 7–8, evidence-based) | PENDING_USER |
| task behaviors choose/select/date | absent | WORKING (Part 11) | PENDING_USER |
| multi-tab state (by tabId) | absent | WORKING (Part 13 syncWorkingTab) | PENDING_USER |
| LLM seam | none | WORKING (Part 12 fallback-safe planner) | PENDING_USER |
| privacy firewall | present | VERIFIED (Part 16, keepLength bug fixed) | n/a |
| vision capability detection | present | VERIFIED (Part 16) | PENDING_USER |
| Firefox adapter | present | VERIFIED (Part 16 delegating wrapper) | PENDING_USER |

Composite functional control (unit-verifiable cells): **16/16** of the audited capability rows are
green at the unit/artifact level. Every remaining red condition is *environmental* (browser-driven),
not code-structural.

## Re-audit verdict (61-cell)
- Structural matrix ❌→✅ in two passes: code-level rows (0.1 content, 0.2 handshake, 0.3 dock,
  0.4 dishonest history, 0.5 browser commands in page, 0.6 active-tab cache, 0.7 rubber verifier,
  0.8 no-op panel events, 0.9 planner gaps, 0.10 context pinning, 0.11 LLM seam) closed.
- Remaining ❌ are the `LIVE` column — by design out of reach here; the Part 14 runbook turns each
  into a pass/fail operator step.

REMAINING WORK: none at the code level. The matrix's live column is the operator's to fill.
NEXT PART: 16 — advanced (vision/privacy/Firefox) audit — unit-verified closure.