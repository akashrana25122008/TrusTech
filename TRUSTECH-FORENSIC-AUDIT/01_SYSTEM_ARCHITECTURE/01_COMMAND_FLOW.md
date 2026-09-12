# Command Flow

Panel layer: useAgentState → bridge.command() → tab → MessageRouter → targeted service → chrome.* API → web page (content script or tabs API).
Agent layer: controller.start(request) → planner → action → executor (CTX_EXECUTE or browser action) → observation → verifier/recovery loop.
Panel events: background → panel via sendPanelEvent (currently a no-op).

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
