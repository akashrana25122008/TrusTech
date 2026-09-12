# Overview

TrusTech is an MV3 Chrome side-panel AI browser-agent. The full architecture is present in source (~85–90%), but the shipped bundle is broken end-to-end (~15–18% functional control).
What works at build level: panel and background (module) bundle fine; 69 unit tests pass; typecheck clean.
What is broken at runtime: content script (SyntaxError), panel–content handshake (hang), dock page actions (unknown_command), back/forward (silent false success), SW-restart tab loss, no-op panel events, rubber-stamp verification.
Companion bot avatar: the Interview-Mentor visual was integrated and verified (budget OK, 69 tests green).

---
*Scope:* TrusTech Chrome extension source tree, dist/ artifacts, tests, build config.
*Method:* line-by-line source review + dist artifact inspection + runtime-path tracing.
*Audit date:* 2026-09-11. *Audit rule:* audit-only, no code modified during audit.
