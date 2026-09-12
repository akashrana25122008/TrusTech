# Router Analysis

MessageRouter v3: guards (URL scheme via page-type classification, capability policy), CONTENT_RPC whitelist = {CTX_OBSERVE, CTX_GROUND, CTX_EXECUTE} — CTX_PING is missing → the panel handshake never completes.
BROWSER_COMMAND switch = {newTab, closeTab, switchTab, reload, back, forward, navigate} — no click/type/scroll/select → dock page actions get unknown_command.
No GET_TAB / LIST_TABS cases; QUERY_ACTIVE_TAB uses the stale-cache path.

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
