# Part 0 — Baseline Snapshot (pre-repair)

- Part: **0**
- Date: 2026-09-11
- Status: verified (snapshot recorded, no functional changes made)
- Files changed by this part: README via audit tree only; **no extension source modified**

## Locked pre-repair facts

| Check | Result |
|---|---|
| `npx vitest run` | 11 files, **69 tests passed** |
| `npm run build` (icons + tsc + vite) | succeeded |
| `tsc --noEmit` | clean |
| Git history | **no commits yet** on `main` (all files untracked) |

## Dist artifacts (evidence)

```
dist/extension/panel.html        0.59 kB
dist/assets/panel-DM-15JdY.css  25.38 kB
dist/js/runtime-D5Is3KbA.js      0.32 kB   exports {o as i, r} (rawApi)
dist/js/background.js           10.75 kB
dist/js/content.js              17.55 kB
dist/js/panel.js               699.91 kB
```

- `dist/js/content.js` line 1 embeds: `import{r as m}from"./runtime-D5Is3KbA.js";`
  → classic script (manifest has no `"type":"module"` for content_scripts) → **SyntaxError on every page = ERROR 1**.
- `background.js` and `panel.js` import the same runtime chunk and ARE valid (module contexts).

## Source proofs (P0 blockers)

| Proof | Location |
|---|---|
| Router content RPC whitelist omits `CTX_PING` | `extension/src/background/router.ts:24` (set = CTX_OBSERVE, CTX_GROUND, CTX_EXECUTE) |
| `onMessage` returns `true` unconditionally (no pending responder tracking) | `extension/src/browser/chrome.ts:166-170`, `:58` |
| `sendPanelEvent` is a no-op | `extension/src/background/main.ts:38` |
| Router already emits 5 event kinds into that no-op | `router.ts:69,110,164,174,184` (CONTENT_READY, PAGE_CHANGED, TAB_CREATED, TAB_CLOSED, TAB_SWITCHED) |

## Runtime symptom model (pre-repair)

1. Page loads → content.js parse fails → no CONTENT_READY, no CTX_PONG, no observe/ground/execute. **(ERROR 1)**
2. Panel/adapter RPC to that tab → `Could not establish connection. Receiving end does not exist.` **(ERROR 2 — consequence of 1)**
3. Controller handshake: `sendRpc(CTX_PING)` unrouted + keepalive always true → promise never resolves → UI stuck on "Connecting to the browser…" (renders explicit ERROR after timeout). **(ERROR 3)**

## Known blockers (pre-repair)

- P0.1 content.js ESM-in-classic (fix: Part 1 build split).
- P0.2 CTX_PING unrouted + always-true keepalive (fix: Part 2).
- P0.3 dock page commands → `unknown_command`; back/forward false success; GET_TAB/LIST_TABS unrouted (Parts 4/5).
- P1 sendPanelEvent no-op (Part 10); SW-restart tab loss (Part 9); verifier rubber-stamp, planner gaps (Parts 7/11).

## Capability matrix (pre-repair)

| Capability | In source | Works live |
|---|---|---|
| content boot | content/main | NO |
| handshake | controller + router | NO |
| observe/ground | content + router | tests only |
| execute | content executor | tests only |
| dock page actions | router | NO |
| back/forward | navigation-manager | NO |
| active tab | tabMgr | intermittent |
| tab list/get | router | NO |
| panel events | background | NO |
| verify/recover | agent | rubber |
| LLM | seam | NO |

Composite functional control: **11 / 61 ≈ 18%**.

## Verification steps (baseline)

- [x] `npx vitest run` → 69 passed
- [x] `npm run build` → success; content.js embeds `import … runtime-D5Is3KbA.js`
- [x] `git log` → no commits yet (baseline cannot rely on history)
- [x] Source proofs above captured with file:line

Next part: **1 — Content Script Build Fix** (standalone classic/IIFE output).