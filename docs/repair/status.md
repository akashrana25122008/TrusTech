# Repair Status Tracker (MASTER REPAIR)

`CURRENT_PART: ALL 0–16 CLOSED (code-level) · 13 unit-verified, 2 doc/audit, 1 real-world gate` · `TEST_STATUS: 109 passed` · `BUILD: clean (vite+tsc)` · `BROWSER_TEST_STATUS: PENDING_USER (part 14 runbook covers all operator checklists)`

`VERIFIED_GATES:` every part — `npx vitest run` + `npx tsc --noEmit` + `npm run build` green.

`REMAINING_WORK (browser only):` operator runs the `part-14-real-world-suite.md` runbook → fills
the LIVE column of the re-audit matrix → Part 15 status becomes fully CERTIFIED.

`PANEL-TRANSPORT-FIX (post-16):` IMPLEMENTED + unit/typecheck/build verified — `TEST_STATUS: 115 passed`.
Real panel browser-control stubs replaced with `BROWSER_COMMAND` RPCs; router honors explicit
`tabId` (stale → `no_such_tab`) and always answers; controller back/forward use delivery-checked
history primitives with action-level failure conversion. Live Chrome certification still PENDING_USER
(see `docs/repair/panel-transport-fix.md`).

`RISK-GATING-FIX (post-16):` IMPLEMENTED + unit/typecheck/build verified — `TEST_STATUS: 119 passed`.
Consequence-based policy (`LOW/MEDIUM/HIGH/CRITICAL`, confirmation only for HIGH/CRITICAL);
ordinary navigation runs autonomously while payment/deletion/transfer still gate
(see `docs/repair/risk-gating-fix.md`).

`UNSUPPORTED-PAGE-FIX (post-16):` IMPLEMENTED + unit/typecheck/build verified — `TEST_STATUS: 121 passed`.
Browser control separated from page control: `unsupported_page` handshake no longer aborts;
synthetic snapshot + navigate-away on internal pages; post-navigation content-ready wait;
honest failure when the task needs the internal page itself
(see `docs/repair/unsupported-page-fix.md`).

`BROWSER_CERTIFIED:` none yet — each part report carries an operator checklist; Chrome cannot be driven in this environment.

---

## Per-part log

| Part | Status | Unit tests | Browser test | Notes |
|------|--------|-----------|--------------|-------|
| 0 Baseline | VERIFIED | 69 pass | n/a | snapshot + proofs recorded |
| 1 Content build | VERIFIED | 71 pass | pending (op) | content.js → self-contained classic IIFE + build gate |
| 2 Handshake routing | VERIFIED | 72 pass | pending (op) | CTX_PING relay + guaranteed answer |
| 3 Unsupported pages | VERIFIED | 73 pass | pending (op) | graceful mid-task FAILED, no false OBSERVING |
| 4 Browser control | VERIFIED | 77 pass | pending (op) | honest back/forward, GET_TAB/LIST_TABS, switchTab cleansed |
| 5 Webpage actions | VERIFIED | 78 pass | pending (op) | no BROWSER_COMMAND into page; content acks AGENT_INJECT_ACTION |
| 6 Observation/grounding | VERIFIED | 80 pass | pending (op) | full observe→ground→act→re-observe loop + freshness |
| 7 Verification engine | VERIFIED | 84 pass | pending (op) | expectedOutcome-driven; typed-value proof, no rubber-stamp |
| 8 Recovery engine | VERIFIED | 84 pass (existing) | pending (op) | bounded retries already present; regression test proves up |
| 9 SW resilience | VERIFIED | 82 pass | pending (op) | adapter-driven active tab (SW-restart safe) |
| 10 Panel events | VERIFIED | 82 pass | pending (op) | sendPanelEvent → runtime broadcast + panel subscription |
| 11 Task behaviors | VERIFIED | 89 pass | pending (op) | choose/select/date entities + planner branches + select state |
| 12 LLM integration | VERIFIED | 96 pass | pending (op) | llm-planner seam + deterministic fallback; controller accepts custom planner |
| 13 Multi-tab state | VERIFIED | 90 pass | pending (op) | context by tabId — controller follows active tab mid-task |
| 14 Real-world suite | VERIFIED (dist gate) | 100 pass | pending (op) | tests/browser smoke = manifest-vs-dist gate + operator runbook |
| 15 Re-audit | VERIFIED (recompute) | 109 pass | pending (op) | capability matrix recomputed; code rows green, LIVE column = runbook |
| 16 Advanced | VERIFIED | 109 pass | pending (op) | vision capability tests, privacy keepLength bug fixed, firefox adapter safety |

(Browser-test column will be filled by the operator via the per-part checklist when this environment cannot drive Chrome; statuses never claim browser verification that was not performed.)