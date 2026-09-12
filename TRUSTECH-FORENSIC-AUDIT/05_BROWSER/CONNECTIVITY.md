# Connectivity

sendToTab wraps chrome.tabs.sendMessage in a promise; sendAndRespond resolves on lastError; deliver maps payloads.
The onMessage wrapper always returns true — the unconditional keepalive is a handshake hazard (see 13_KNOWN_BUGS_AND_ISSUES).

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
