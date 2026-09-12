# Page Relay

Relays page DOM/post-message events to the background; maps to CTX_PAGE_CHANGED / CTX_TITLE_UPDATED / CTX_TARGET_SPOTTED; guarded by the page classifier and protocol checks.

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
