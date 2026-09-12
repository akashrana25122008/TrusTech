# Priority Matrix

| ID | Part | Why | Severity |
|---|---|---|---|
| P0.1 | 1 | ERROR 1 | critical |
| P0.2 | 2 | ERROR 3 | critical |
| P0.3 | 4 | silent success | high |
| P1.1 | 5 | dock UX dead | high |
| P1.2 | 4 | tab UX dead | high |
| P1.3 | 10 | observability | medium |
| P1.4 | 9 | SW correctness | medium |
| P1.5 | 7,8 | agent correctness | high |
| P1.6 | 11 | task completion | medium |
| P2.1 | 12 | product value | medium |
| P2.2 | 13 | multi-tab | medium |
| P2.3 | 14 | ship-safe | medium |
| P2.4 | 16 | premium | low |

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
