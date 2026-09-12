# Capability Matrix

| Capability | In source | Works live |
|---|---|---|
| content boot | content/main | NO (B1) |
| handshake | controller + router | NO (B2/B3) |
| observe/ground | content + router | tests only |
| execute | content executor | tests only |
| dock page actions | router | NO (B4) |
| back/forward | navigation-manager | NO (B5) |
| active tab | tabMgr | intermittent (B6) |
| tab list/get | router | NO (B7) |
| panel events | background | NO (B8) |
| verify/recover | agent | rubber (B9) |
| LLM | seam | NO (B11) |

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
