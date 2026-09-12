# Test Matrix

69 tests, vitest + jsdom: controller/adapter/fakeWeb (handshake, CTX_* flows), router (projection/permission/relay/BROWSER_COMMAND), content envoy paths, bot-state-adapter (2), executor/indexer/grounder/observer, navigation, tab-state repo, messaging. All pass.

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
