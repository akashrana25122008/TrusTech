# Content Channel

ContentChannel (classic-script compatible): ports to the observer, client subscriptions (ensure/forget), publishes CONTENT_READY/PAGE_CHANGED; ensure() is used by the router before RPC; attachments are guarded by the URL whitelist.

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
