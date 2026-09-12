# Fix Plan (Master)

Ordered parts 0–16, one at a time, each verified (unit + build; real browser by the operator) before the next: 0 baseline → 1 content build → 2 handshake/routing → 3 unsupported pages → 4 browser control routing → 5 webpage-action routing → 6 observation+grounding live → 7 verification engine → 8 recovery engine → 9 SW resilience → 10 panel event channel → 11 task behaviors → 12 LLM integration → 13 multi-tab state → 14 real-world suite → 15 re-audit → 16 advanced.
Never advance past an unverified part.

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
