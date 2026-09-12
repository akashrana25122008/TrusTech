# State Machine

AgentStatus: THINKING → (READY|GATHERING) → OBSERVING → ACTIVE → … → DONE/ERROR/CANCELLED.
Panel renders status + error; the bot avatar maps via bot-state-adapter (idle/working/thinking/success/error/unavailable).

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
