# FINAL_REPORT — MASTER REPAIR (Parts 0–16 closed at code level)

Date: 2026-09-11 · Scope: audit root causes + parts 0–16 implemented and unit/artifact verified.

## Gate results (final)

| Gate | Result |
|---|---|
| `npx vitest run` | **121 passed** (18 files; was 69 at baseline) |
| `npx tsc --noEmit` | clean |
| `npm run build` | OK (icons + tsc + vite; dist layout matches `public/manifest.json`) |
| Git | still no commits on `main` (per instructions, left for operator) |

## Root causes closed (per part)

| # | Root cause | Fix | Evidence |
|---|---|---|---|
| 1 | `dist/js/content.js` ESM-imported in a classic context → SyntaxError on every page | Part 1: standalone classic IIFE build split (`vite.content.config.ts`), build gate `tools/verify-content-build.mjs` | `tests/extension/build-content.test.ts`; baseline `import{…}` line gone |
| 2 | `CTX_PING` unrouted; keepalive always true → handshake never resolves | Part 2: `CONTENT_RPC_TYPES` restored + guaranteed `{ok:false,error:"unhandled_message"}` answer | controller handshake tests |
| 3 | Dock page commands → `unknown_command`; back/forward false success; tab queries unrouted | Parts 4–5: router `LIST_TABS`/`GET_TAB`/`newWindow` + `deliverChecked` inject-on-miss retry; controller splits browser/chrome-navigation actions; content only handles `AGENT_INJECT_ACTION` | `adapter.test.ts`, `controller.test.ts` |
| 6 | SW-restart wipes active-tab cache | Part 9: `TabManager.active()` async, cold path `adapter.queryActiveTab()` | router awaits all 4 call sites |
| 7 | Verifier rubber-stamp (always ok) | Part 7: planner declares `expectedOutcome`; verifier proves typed value / URL / content change with evidence | `agent-core.test.ts` pass+fail cases |
| 8 | (TTL) recovery loop ungoverned | Part 8: bounded retries already implemented; regression test proves give-up | `agent-core` "bounded retries then gives up" |
| 10 | Panel events no-op | Part 10: `BrowserAdapter.broadcast` → `runtime.sendMessage`; `PanelsService.broadcast`; panel `onMessage` subscription | `panel-adapter.test.ts` |
| 11 | choose/select/date behaviors absent | Part 11: interpreter `option`/`date` entities, planner select/date branches, `<select>` selected state | `deterministic-planner.test.ts` (5 new) |
| 13 | context pinned to one tabId for the whole task | Part 13: controller re-resolves active tab every iteration (`syncWorkingTab`), follows tab switches, emits `TAB_CHANGED` | `controller.test.ts` mid-task switch regression |
| 12 | no live entry point for a configured LLM provider | Part 12: `buildLlmPlanner` (provider + deterministic fallback) pluggable into the controller | `llm-planner.test.ts` (5) + controller custom-planner test |
| 14 | no dist-vs-manifest gate after build | Part 14: `tests/browser/smoke.test.ts` (CI gate) + operator runbook | smoke gate + runbook doc |
| 16 | advanced areas unverified (regressed silently) | Part 16: privacy `keepLength` bug fixed + edge tests; vision capability/DOM tests; firefox adapter safety tests | `privacy/vision/firefox.test.ts` 9 new |
| panel-transport | live controller got false `ok:true` from panel stubs (STEP 1/5 fail) | Panel methods → real `BROWSER_COMMAND` RPCs; router explicit-`tabId` + always-answers; controller back/forward via `goBack/goForward` with action-level failure conversion | `panel-adapter.test.ts` (+4), `adapter.test.ts` (+2) |
| risk-gating | every navigate gated at STEP 1/5 (external URL = confirmation) | Consequence-based `LOW/MEDIUM/HIGH/CRITICAL` policy; confirmation only for HIGH/CRITICAL; engine/UI/recovery untouched | `agent-core.test.ts` risk matrix (+4) |
| unsupported-page | task died on `chrome://newtab/` before any action (page vs browser control conflated) | Handshake `unsupported_page` no longer aborts; synthetic snapshot + navigate-away; post-navigation content-ready wait; honest failure when the internal page itself is needed | `controller.test.ts` internal-page cases (+2) |

## Capability matrix — post-repair (unit truth)

| Capability | Status (unit-verified) | Live browser |
|---|---|---|
| content boot | WORKING (Part 1) | PENDING_USER |
| handshake | WORKING (Part 2) | PENDING_USER |
| observe/ground | WORKING (Part 6) | PENDING_USER |
| execute | WORKING | PENDING_USER |
| dock page actions | WORKING (Parts 4–5) | PENDING_USER |
| back/forward honesty | WORKING (Part 4) | PENDING_USER |
| active tab (SW-restart) | WORKING (Part 9) | PENDING_USER |
| tab list/get | WORKING (Part 4) | PENDING_USER |
| panel events | WORKING (Part 10) | PENDING_USER |
| verify/recover | WORKING (Parts 7–8) | PENDING_USER |
| task behaviors (choose/select/date) | WORKING (Part 11) | PENDING_USER |
| multi-tab state (context by tabId) | WORKING (Part 13) | PENDING_USER |
| LLM seam (fallback-safe) | WORKING (Part 12) | PENDING_USER |
| privacy firewall | WORKING (Part 16; keepLength fixed) | n/a |
| vision capability detection | WORKING (Part 16) | PENDING_USER |
| Firefox adapter | WORKING (Part 16) | PENDING_USER |

Every capability now has a green unit gate — composite functional control is bounded only by the
un-performed browser certifications below.

## Operator follow-up (unavoidable in this environment)

1. Run the `docs/repair/part-14-real-world-suite.md` runbook in Chrome (loads `dist/`, drives the
   panel through the part checklists) — plus the live proof in
   `docs/repair/panel-transport-fix.md` (STEP 1 must navigate for real, then A–G browser
   controls individually).
2. Optionally configure a real LLM provider into `buildLlmPlanner` (Part 12 seam), and repeat the
   runbook.
3. After the runbook passes, flip the LIVE column in `part-15-reaudit.md` to CERTIFIED.

## Diff footprint (repair scope)

- `extension/src/…`: content/main, agent/{controller,verifier,recovery,task-interpreter,deterministic-planner,llm-planner},
  background/{router,tab-manager,navigation-manager,panels,main}, browser/{adapter,chrome,panel,index},
  shared/{messages,event-bus}, content/accessibility-reader, privacy/detector, vite.content.config.ts (new).
- `tests/…`: extension/{build-content,controller,adapter,grounder,agent-core,panel-adapter,llm-planner,
  deterministic-planner,vision,firefox,privacy} + browser/smoke.test.ts.
- `docs/repair/…`: baseline + part-01…part-16 reports + panel-transport-fix.md + risk-gating-fix.md + unsupported-page-fix.md + status.md + FINAL_REPORT.md.