# Data Flow

Page → observer events → ContentChannel relay (CTX_PAGE_CHANGED) → router → tabStateRepository + panel (events, currently disabled) → panel AgentState → UI.
Grounding: indexer → grounder → CTX_GROUND payloads.
Agent commands: PanelTransportAdapter → CTX_* → router → executor.
Dock: BROWSER_COMMAND → router → TabService (limited to tab-level commands).

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
