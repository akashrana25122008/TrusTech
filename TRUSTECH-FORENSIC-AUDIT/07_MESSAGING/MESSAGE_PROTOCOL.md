# Message Protocol

RPC envelope {type, payload}; type groups: browser RPC (inbound to background/panel), CONTENT_RPC (relayed to content), AGENT_* (injected actions/broadcasts), CTX_* (content → background), EVENT_* (background → panel), BROWSER_COMMAND* (dock → router), QUERY_* (panel → background).
Responses via the chrome sendResponse promise.

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
