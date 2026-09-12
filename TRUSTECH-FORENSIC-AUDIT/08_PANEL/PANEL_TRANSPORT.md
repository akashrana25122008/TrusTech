# Panel Transport

PanelTransportAdapter: sendRpc (browser/agent/scan/invoke), sendTabCommand, sendToBackground, onMessage, batchEmitter, and _rpc variants.
Uses GET_TAB / LIST_TABS which have no router cases (see 13).

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
