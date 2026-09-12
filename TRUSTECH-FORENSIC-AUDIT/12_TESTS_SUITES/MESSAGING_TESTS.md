# Messaging Tests

Cover URL guards, content whitelist relaying, BROWSER_COMMAND subset, channel ensure/forget, controller handshake (fakeWeb answers CTX_PING → CTX_PONG).
Missing: CTX_PING relay assertion, GET_TAB/LIST_TABS, panel event path, SW-restart active-tab — added by the respective repair parts.

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
