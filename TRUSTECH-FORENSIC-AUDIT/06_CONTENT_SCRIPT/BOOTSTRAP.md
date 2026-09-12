# Bootstrap

content/main.ts: classifier → channel.attachListeners + handleMessage → observer.attach (with unsupported-page fallback and guarded bot overlays) → handshake (CTX_PING / CONTENT_READY broadcast).
All future behavior (RPC, PAGE_CHANGED, execute) hangs off this boot — which currently crashes at parse time.

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
