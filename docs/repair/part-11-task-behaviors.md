# Part 11 — Task Behaviors: Choose / Select / Date (Report)

STATUS: **VERIFIED (unit + typecheck + build)**
UNIT TESTS: 89 passed (adds interpreter + deterministic planner behavior coverage)
BROWSER TEST: **PENDING_USER** — checklist at bottom

## Changes
- `extension/src/agent/task-interpreter.ts`
  - New entities: `option` (capture after choose/select/pick, e.g. "AC coach") and `date`
    (dd/mm/yyyy, dd-mm-yyyy, yyyy-mm-dd).
  - Entity extraction now prefers the regex capture group over the whole match.
- `extension/src/agent/deterministic-planner.ts` — new `choose/select/pick` branch:
  - Date picker: an `input[type=date]` → typed `type` action with the goal's date, verified as
    `element_state`.
  - Dropdown/listbox: `select` action on the combobox/select-one/listbox with the named option,
    verified as `elementState.selected:true`.
- `extension/src/content/accessibility-reader.ts` — `<select>` reports `selected` (index set) so
  the verifier can confirm real selections.
- Tests: `tests/extension/deterministic-planner.test.ts` — interpreter entity extraction (option,
  date), select-with-expected-outcome planning, typed-date planning, and the generic fallback.

## Root cause (audit FINDING 10)
The deterministic planner only served search-style intents (navigate/type/Enter/finish). Booking,
form, and comparison tasks whose steps say "select available options" or "pick a date" fell into
the generic "read page and finish" — the agent never picked anything, so choose/select/date
behaviors silently did nothing.

## Verified evidence
- `interpretTask("select AC coach …")` → entity `option:"AC coach"`.
- `interpretTask("depart on 25/12/2026")` → entity `date:"25/12/2026"`.
- Combobox + option → plan = `select` on `el_001` with `expectedOutcome.elementState.selected`.
- Date input + date figure → plan = `type` `"25/12/2026"` into the date field with `element_state`
  verification.
- No matching widget → honest `finish` fallback (still reads the page).

## Real browser test (operator)
1. "Select AC coach on a booking form": agent must open the Select and choose the option (visible
   selection change), then pass verification evidence.
2. "Depart on 25/12/2026": agent fills the date field (yyyy-mm-dd formatted by the field) and the
   verifier confirms the element value.

REMAINING ISSUES: richer behaviors (checkboxes, multi-select, calendar widgets) are LLM-planner
(Part 12) + future scope.
NEXT PART: 8 previously deferred — Recovery engine bounded retries (verify gate).