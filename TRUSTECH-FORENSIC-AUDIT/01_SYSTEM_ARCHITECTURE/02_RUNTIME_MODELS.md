# Runtime Models

Three MV3 contexts:
1. Service worker (module): router, TabManager, tabStateRepository, ContentChannel, adapter. Controller is instantiable only in the panel.
2. Side panel: React app + PanelTransportAdapter + agent/controller + dock.
3. Content script: ContentChannel + observer/indexer/grounder/executor (currently blocked by the build bug).
Shared runtime.ts provides sendRaw and message wrappers.

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
