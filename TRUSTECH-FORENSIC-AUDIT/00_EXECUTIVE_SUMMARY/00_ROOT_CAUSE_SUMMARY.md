# Root Cause Summary

Chain of causation (one sentence each):
1. ERROR 1 — content script cannot load. Vite multi-entry build split a shared runtime chunk; dist/js/content.js line 1 is import{r as m}from"./runtime-D5Is3KbA.js"; MV3 content_scripts are classic scripts, so the browser throws Uncaught SyntaxError: Cannot use import statement outside a module on every page.
2. ERROR 2 — Could not establish connection. Receiving end does not exist. The content script is dead, so chrome.tabs.sendMessage to it has no receiver.
3. UI stuck on Connecting to the browser… . The router never relays CTX_PING (the CONTENT_RPC_TYPES whitelist omits it) and chrome.ts onMessage always returns true, so the panel handshake promise never resolves.
4. Latent gaps: dock page commands (unknown_command), back/forward silent false success, GET_TAB/LIST_TABS unrouted, SW-restart tab loss, no-op panel events, rubber-stamp verification.

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
