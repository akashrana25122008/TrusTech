# Part 1 — Content Script Build Fix (Report)

STATUS: **VERIFIED (build-level)**
UNIT TESTS: 71 passed (69 baseline + 2 new artifact-contract tests)
BROWSER TEST: **PENDING_USER** (no Chrome runtime in this environment) — checklist at bottom

## Changes
- `vite.config.ts` — removed the `content` input; module entries (`panel` html, `background`) only.
- `vite.content.config.ts` (new) — standalone content build: single input, `format: "iife"`,
  `inlineDynamicImports`, `entryFileNames js/content.js`, `emptyOutDir false`, `copyPublicDir false`,
  `publicDir false`, plus an `output.plugins.renderChunk` hook that strips `export {};` and wraps the
  WHOLE emitted chunk (including Rollup's hoisted interop prelude `__defProp/__defNormalProp/…` in
  an outer strict IIFE so nothing leaks to `window`).
- `package.json` — build script now: `npm run icons && tsc --noEmit && vite build && vite build --config vite.content.config.ts && node tools/verify-content-build.mjs`.
- `tools/verify-content-build.mjs` (new) — build gate: fails the build if content.js contains
  import/export tokens, references a `runtime-*.js` chunk, or is not IIFE-wrapped.
- `tests/extension/build-content.test.ts` (new) — vitest regression on the same contract (skips cleanly when dist isn't built).

## Root cause
Vite multi-entry build hoisted `runtime.ts` (`rawApi`) into `runtime-D5Is3KbA.js`; `content.js` line 1
was `import{r as m}from"./runtime-D5Is3KbA.js";`. MV3 `content_scripts` are classic scripts → parse
SyntaxError on every page (ERROR 1). Secondary: `format:"iife"` alone still emitted top-level
`var pe=…` helper prelude outside the IIFE → global leak; fixed by the wrap hook.

## Verified evidence (dist/js)
- `content.js` (18.72 kB): starts `(function(){\n"use strict";var pe=…})();`; `node --check` parses OK;
  0 top-level import/export; 0 `runtime-*.js` references.
- `background.js`, `panel.js` unchanged module entries (they may import the runtime chunk — valid).

## Real browser test (operator, please run)
1. `npm run build` (should print `verify-content-build: OK`).
2. `chrome://extensions` → Load unpacked → select `dist/`.
3. Open `https://google.com` → DevTools → Console: expect **no** `Uncaught SyntaxError: Cannot use import statement outside a module`.
4. Repeat on `https://youtube.com`. Confirm `CONTENT_READY` handshake fires (background service worker console).
Record result as PASS/FAIL below.

REMAINING ISSUES: none for the build artifact. (Interop helpers wrapped; content still isolation-clean for MV3.)
NEXT PART: 2 — Handshake / Message routing (CTX_PING relay).