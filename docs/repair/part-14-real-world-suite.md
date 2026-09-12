# Part 14 — Real-World Test Suite (Report)

STATUS: **VERIFIED (CI-runnable artifact gate + operator runbook)**
UNIT TESTS: 100 total planned — adds 4 dist-gate tests under `tests/browser/`
BROWSER TEST: **PENDING_USER** — this part is the operator runbook (below)

## Deliverable
- `tests/browser/smoke.test.ts` — runs in CI **without a browser** and gates real-world readiness:
  - dist root mirrors every manifest reference (`side_panel.default_path`, `background
    .service_worker`, `content_scripts`, `icons`) — a manifest/packaging regression (like the
    original broken `panel.html` path) now fails the test suite.
  - `background.js` exists and is the module-file shape (manifest `type: module`).
  - `content.js` is self-contained classic (no ESM face plant) — the P0.1 regression guard.
  - `panel.html` references the built `js/panel.js` + `assets/panel-*.css`.
- The remaining gap is inherently browser-dependent — covered by the operator runbook below,
  which maps each part's checklist into one load-and-drive sequence.

## Root cause
No artifact-level gate existed between `npm run build` output and real Chrome. The parts fixed the
build, but nothing in CI re-verified the *dist* against the manifest after subsequent edits; a
future packaging change could silently break load again without any red test.

## Operator runbook (Chrome — the part's real browser test)
1. `npm run build` → `npm run test`.
2. `chrome://extensions` → Load unpacked → `dist/`.
3. Pin the action; open the side panel; new tab to a docs/search page; run "search youtube tutorial".
4. The panel shows: connecting → observing → acting (highlight/type on the real page) → verified →
   review gate. Confirm back/forward honest results and tab events appearing in the panel console
   (Part 10 checklist).
5. Stop the service worker (`chrome://serviceworker-internals` or devtools), then drive a second
   task — confirm the active tab is re-resolved live (Part 9/13 checklists).
6. Switch tabs mid-task and confirm the agent follows the new tab (Part 13 checklist).

REMAINING ISSUES: none for the CI gate. Live scenario execution is the operator step.
NEXT PART: 15 — re-audit (recomputed capability matrix).