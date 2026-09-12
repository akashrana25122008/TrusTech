# Panel Event Channel (disconnected)

Background sends EVENT_CONTENT_READY / EVENT_PAGE_CHANGED via sendPanelEvent → no-op (background/main.ts). PanelTransportAdapter.onMessage is a no-op.
The panel never learns pages changed or content readiness except through its own queries.

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
