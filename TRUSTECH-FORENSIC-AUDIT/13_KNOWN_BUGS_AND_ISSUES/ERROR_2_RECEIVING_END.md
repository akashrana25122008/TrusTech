# ERROR 2 — Could not establish connection

Evidence: panel/adapter sendRpc to content → Could not establish connection. Receiving end does not exist. because the content script never registered a receiver (ERROR 1).
Secondary: a sendAndRespond to a missing port raises the same error.

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
