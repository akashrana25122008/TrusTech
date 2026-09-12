# Chrome Adapter

BrowserTabAdapter: queryActiveTab, getTab, listTabs, captureVisibleTab, navigateTab, createTab, switchTab, closeTab, reloadTab, injectFallback, sendToTab, sendToTabAndRespond, sendAndRespond, deliver, sendRaw via runtime.ts.
Injectable fakes are used in every test.

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
