/* ------------------------------------------------------------------ *
 * ActionExecutor — performs real DOM actions for the agent. Every
 * element action goes through the grounder first: stale ids and weak
 * targets never execute. Returns an ActionResult with a hint the
 * verifier can check against reality.
 * ------------------------------------------------------------------ */

import type { AgentAction } from "@/shared/action-schema";
import type { ActionResult } from "@/shared/messages";
import { groundTarget } from "./grounder";
import { isLive, resolveId } from "./indexer";
import { findElement, fallbackElement } from "./overlay";

function ok(hint?: ActionResult["hint"], details?: string): ActionResult {
  return details === undefined ? { ok: true, hint } : { ok: true, hint, details };
}

function fail(error: string, details?: string): ActionResult {
  return { ok: false, error, details };
}

function triggerType(el: HTMLElement, value: string): void {
  if (el.isContentEditable) {
    el.textContent = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el) as object, "value")?.set;
  if (setter) {
    setter.call(el, value);
  } else {
    (el as HTMLInputElement).value = value;
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function clickAt(el: Element, double: boolean): void {
  const r = el.getBoundingClientRect();
  const mid = () =>
    new MouseEvent(double ? "dblclick" : "click", {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: r.left + r.width / 2,
      clientY: r.top + r.height / 2,
    });
  el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  el.dispatchEvent(mid());
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Poll until `done()` is true or the bound expires. Bounded waiting for a
 *  browser effect — never a blind sleep, never unbounded. */
async function pollFor(done: () => boolean, timeoutMs: number, stepMs = 150): Promise<boolean> {
  const t0 = Date.now();
  for (;;) {
    if (done()) return true;
    if (Date.now() - t0 >= timeoutMs) return done();
    await sleep(stepMs);
  }
}

function isVisibleInput(el: Element): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  const r = el.getBoundingClientRect();
  // jsdom reports zero rects — treat attached elements as visible there.
  const zeroRect = r.width === 0 && r.height === 0;
  const inJsdom = /jsdom/i.test(navigator.userAgent);
  if (!zeroRect && (r.width <= 0 || r.height <= 0)) return false;
  if (!inJsdom && zeroRect && !el.isConnected) return false;
  const style = getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return false;
  if (el instanceof HTMLInputElement && (el.disabled || el.type === "hidden")) return false;
  if (el instanceof HTMLTextAreaElement && el.disabled) return false;
  return true;
}

/** Generic search-field resolution (no site knowledge): real search inputs
 *  first, then any visible text entry. Never coordinates, never XPath. */
function findSearchInput(): HTMLElement | null {
  const inputs = Array.from(
    document.querySelectorAll("input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio]):not([type=file]), textarea, [role=textbox], [role=searchbox]"),
  ).filter((el) => el instanceof HTMLElement && isVisibleInput(el)) as HTMLElement[];
  if (inputs.length === 0) return null;
  const score = (el: HTMLElement): number => {
    let s = 0;
    if (el instanceof HTMLInputElement && el.type === "search") s += 4;
    if (el.getAttribute("role") === "searchbox") s += 4;
    const label = `${el.getAttribute("aria-label") ?? ""} ${el.getAttribute("placeholder") ?? ""} ${el.getAttribute("name") ?? ""} ${(el as HTMLInputElement).type ?? ""}`.toLowerCase();
    if (/\bsearch\b/.test(label)) s += 3;
    if (/query|find|lookup/.test(label)) s += 1;
    return s;
  };
  inputs.sort((a, b) => score(b) - score(a));
  return inputs[0] ?? null;
}

/** Generic search/submit button resolution, scoped near the input first,
 *  then page-wide. No site selectors. */
function findSearchButton(input: HTMLElement): HTMLElement | null {
  const labelHit = (el: Element): boolean => {
    const label = `${el.getAttribute("aria-label") ?? ""} ${el.textContent ?? ""} ${el.getAttribute("title") ?? ""} ${(el as HTMLInputElement).value ?? ""} ${el.getAttribute("name") ?? ""}`;
    return /\b(search|go|submit|find)\b/i.test(label);
  };
  const usable = (el: Element | null): el is HTMLElement =>
    !!el && el instanceof HTMLElement && isVisibleInput(el) && !(el instanceof HTMLInputElement && el.disabled) && !(el instanceof HTMLButtonElement && el.disabled);
  const scopes: Element[] = [];
  const form = input.closest("form");
  if (form) scopes.push(form);
  if (input.parentElement) scopes.push(input.parentElement);
  scopes.push(document.body ?? document.documentElement);
  for (const scope of scopes) {
    // Explicit submit controls first — deterministic, no text guessing.
    const submit = scope.querySelector("button[type=submit], input[type=submit], input[type=image]");
    if (usable(submit)) return submit;
  }
  for (const scope of scopes) {
    const buttons = Array.from(scope.querySelectorAll("button, input[type=button], [role=button]"));
    // Never offer the input itself back as its own submit button.
    const hit = buttons.find((b) => b !== input && usable(b) && labelHit(b));
    if (hit) return hit as HTMLElement;
  }
  return null;
}

function dispatchEnter(el: Element): void {
  // keyCode/which are legacy aliases — Chrome honors them in the init dict
  // and several site handlers still read them instead of `key`.
  const down = { bubbles: true, cancelable: true, key: "Enter", code: "Enter", keyCode: 13, which: 13 } as KeyboardEventInit;
  el.dispatchEvent(new KeyboardEvent("keydown", down));
  el.dispatchEvent(new KeyboardEvent("keypress", down));
  el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, cancelable: true, key: "Enter", code: "Enter" }));
}

/**
 * Submit a search input with a bounded, deterministic fallback chain:
 * enclosing form → Enter on the focused input → explicit search button.
 * Returns the method that produced an observable browser effect, or a
 * structured no-effect failure. Never reports success on dispatch alone.
 */
async function submitInput(
  input: HTMLElement,
): Promise<{ ok: true; method: "form" | "enter" | "button" } | { ok: false; tried: string[] }> {
  const tried: string[] = [];
  const preUrl = location.href;
  const preText = document.body?.innerText ?? "";
  const preCount = document.querySelectorAll("*").length;
  const changed = () =>
    location.href !== preUrl ||
    (document.body?.innerText ?? "") !== preText ||
    document.querySelectorAll("*").length !== preCount;

  const form = input instanceof HTMLFormElement ? input : input.closest("form");
  if (form) {
    tried.push("form");
    try {
      if (typeof form.requestSubmit === "function") form.requestSubmit();
      else form.submit();
    } catch {
      /* synthetic-submit rejected — fall through to Enter */
    }
    if (await pollFor(changed, 1200)) return { ok: true, method: "form" };
  }

  tried.push("enter");
  input.focus();
  dispatchEnter(document.activeElement instanceof Element ? document.activeElement : input);
  if (await pollFor(changed, 1200)) return { ok: true, method: "enter" };

  const button = findSearchButton(input);
  if (button) {
    tried.push("button");
    if (button instanceof HTMLButtonElement || (button instanceof HTMLInputElement && /submit|button|image/.test(button.type))) {
      button.click();
    } else {
      clickAt(button, false);
    }
    if (await pollFor(changed, 1500)) return { ok: true, method: "button" };
    return { ok: false, tried };
  }
  tried.push("no_button");
  return { ok: false, tried };
}

function elementFor(action: AgentAction, groundedId?: string): Element | ActionResult {
  if (groundedId) {
    if (!isLive(groundedId)) return fail("stale_target", `el ${groundedId} is no longer in the DOM`);
    return resolveId(groundedId)!;
  }
  if (action.target) {
    const g = groundTarget(action.target);
    if (g.status !== "ok" || !g.elementId) return fail(g.status, g.reason);
    return resolveId(g.elementId)!;
  }
  return fail("missing_target", "action has no target");
}

export async function executeAction(action: AgentAction, groundedId?: string): Promise<ActionResult> {
  const a = action.action;

  if (a === "wait") {
    await sleep(Math.min(Math.max(action.ms ?? 500, 0), 10_000));
    return ok();
  }

  // press_key acts on the focused element and needs no indexed target —
  // requiring one made every real Enter submission fail as
  // "missing_target" before touching the DOM. Focus is VERIFIED, never
  // assumed: Enter dispatched to <body> (or a detached node) is a lost
  // keystroke, and losing it silently is what produced the "typed query,
  // suggestions shown, results never appear" defect.
  if (a === "press_key") {
    const active = document.activeElement as HTMLElement | null;
    if (!active || active === document.body || active === document.documentElement || !active.isConnected) {
      return fail(
        "no_focused_element",
        `press_key ${action.key ?? ""} has nowhere to go: no element holds focus`,
      );
    }
    if (action.key === "Enter" && active instanceof HTMLButtonElement) {
      active.click();
      return ok();
    }
    if (action.key === "Enter" && (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active.isContentEditable)) {
      // Text-field Enter is a submit: run the same bounded form → Enter →
      // button chain as SEARCH so a lost keystroke can never read as a
      // completed submission. Effect (not dispatch) decides the result.
      const submitted = await submitInput(active);
      if (submitted.ok) return ok({ text: `submitted via ${submitted.method}` }, `submitted via ${submitted.method}`);
      return fail("submit_no_effect", `Enter dispatched and fallbacks tried (${submitted.tried.join(" → ")}); the page did not change`);
    }
    const down = { bubbles: true, cancelable: true, key: action.key ?? "", code: action.key ?? "" } as KeyboardEventInit;
    active.dispatchEvent(new KeyboardEvent("keydown", down));
    active.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, cancelable: true, key: action.key ?? "" }));
    if (action.key === "Escape" && "blur" in active) (active as HTMLElement).blur();
    return ok();
  }

  // SEARCH — the semantic composite. TYPE(query) only fills the input
  // stage; SEARCH additionally submits and requires an observable
  // result. Stages: resolve input → validate → focus → enter query →
  // verify value → submit (form → Enter → button) → verify results.
  if (a === "search") {
    const query = action.text ?? "";
    if (!query) return fail("missing_query", "search requires a query; the planner must never emit one without it");
    // 1-2. Resolve + validate the search input. An explicitly grounded
    // target that no longer resolves is a planner error — fail honestly
    // rather than typing into an arbitrary field. Only a targetless
    // SEARCH self-resolves a search field.
    let input: Element | null = null;
    if (groundedId) {
      if (!isLive(groundedId)) return fail("stale_target", `el ${groundedId} is no longer in the DOM`);
      input = resolveId(groundedId);
    } else if (action.target) {
      const g = groundTarget(action.target);
      if (g.status !== "ok" || !g.elementId) return fail(g.status, g.reason);
      input = resolveId(g.elementId);
    } else {
      input = findSearchInput();
      if (!input) return fail("search_input_not_found", "no visible search field on this page");
    }
    if (!input || !(input instanceof HTMLElement) || !isVisibleInput(input)) {
      return fail("invalid_target", "search target is not a visible, enabled input");
    }
    const editable =
      input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement || input.isContentEditable;
    if (!editable) {
      return fail("invalid_target", "search target is not an editable field");
    }
    // 3. Focus — verified, with one explicit retry. A search submitted
    // from the wrong focus is the exact lost-Enter defect.
    input.focus();
    if (document.activeElement !== input) {
      input.focus();
      if (document.activeElement !== input) {
        return fail("input_not_focusable", "search field could not take focus; Enter would go nowhere");
      }
    }
    // 4-5. Enter the query (skip retyping an identical value) and read
    // the value back from the live element — never trust the plan text.
    const current = input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement ? input.value : (input.textContent ?? "");
    if (current !== query) {
      triggerType(input, query);
      const readBack = input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement ? input.value : (input.textContent ?? "");
      if (readBack !== query) {
        return fail("query_not_accepted", "the search field did not accept the query value");
      }
    }
    // 6-7. Submit with the bounded fallback chain; only an observed
    // browser effect counts as submission.
    const submitted = await submitInput(input);
    if (!submitted.ok) {
      return fail(
        "submit_no_effect",
        `query "${query.slice(0, 60)}" is in the field but submission had no effect (tried ${submitted.tried.join(" → ")})`,
      );
    }
    return ok({ value: query, text: `submitted via ${submitted.method}` }, `submitted via ${submitted.method}`);
  }

  const el = elementFor(action, groundedId);
  if ("ok" in (el as ActionResult)) {
    return el as ActionResult;
  }
  const target = el as Element;

  let hint: ActionResult["hint"] = {};
  switch (a) {
    case "click":
    case "double_click":
      clickAt(target, a === "double_click");
      hint = { text: (target.textContent ?? "").trim().slice(0, 80) || ((target as HTMLElement).getAttribute?.("aria-label") ?? undefined) };
      break;

    case "type": {
      (target as HTMLElement).focus();
      triggerType(target as HTMLElement, action.text ?? "");
      hint = { value: action.text };
      break;
    }

    case "clear": {
      (target as HTMLElement).focus();
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        target.select();
        document.execCommand?.("delete");
      } else {
        triggerType(target as HTMLElement, "");
      }
      hint = { value: "" };
      break;
    }

    case "select": {
      if (target instanceof HTMLSelectElement) {
        target.value = action.option ?? target.value;
        target.dispatchEvent(new Event("change", { bubbles: true }));
        hint = { selected: target.value };
      } else {
        (target as HTMLElement).focus();
        (target as HTMLInputElement).select?.();
        hint = { value: "" };
      }
      break;
    }

    case "check":
    case "uncheck":
    case "radio": {
      if (target instanceof HTMLInputElement) {
        target.checked = a === "check" || a === "radio";
        target.dispatchEvent(new Event("input", { bubbles: true }));
        target.dispatchEvent(new Event("change", { bubbles: true }));
        clickAt(target, false);
        hint = { checked: target.checked };
      } else if (target.getAttribute("role") === "checkbox" || target.getAttribute("role") === "radio") {
        target.setAttribute("aria-checked", a === "check" || a === "radio" ? "true" : "false");
        clickAt(target, false);
        hint = { checked: a === "check" || a === "radio" };
      } else {
        return fail("invalid_target", `${a} requires a checkbox/radio`);
      }
      break;
    }

    case "scroll":
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      hint = { text: (target.textContent ?? "").trim().slice(0, 80) || undefined };
      break;

    case "hover":
      target.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      target.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true, cancelable: true }));
      break;

    case "focus":
      (target as HTMLElement).focus();
      break;

    case "submit": {
      const form = target instanceof HTMLFormElement ? target : (target as HTMLElement).closest("form");
      if (!form) {
        return fail("invalid_target", "submit requires a form");
      }
      // A form submission is only real when the browser acts on it:
      // requestSubmit, then a bounded wait for an observable effect, then
      // the submit control itself as fallback (verified live: synthetic
      // requestSubmit can fire without committing while a control click
      // does). The fallback only runs when NOTHING changed, so a working
      // submission is never doubled.
      const preSubmitUrl = location.href;
      const preSubmitText = document.body?.innerText ?? "";
      const preSubmitCount = document.querySelectorAll("*").length;
      const submitted = () =>
        location.href !== preSubmitUrl ||
        (document.body?.innerText ?? "") !== preSubmitText ||
        document.querySelectorAll("*").length !== preSubmitCount;
      let method: string | null = null;
      try {
        // requestSubmit (validating, event-firing) only — never the raw
        // form.submit() bypass.
        if (typeof form.requestSubmit === "function") form.requestSubmit();
      } catch {
        /* fall through to the control fallback below */
      }
      if (await pollFor(submitted, 1500)) {
        method = "form";
      } else {
        const control =
          target instanceof HTMLButtonElement || target instanceof HTMLInputElement
            ? (target as HTMLElement)
            : form.querySelector<HTMLElement>(
                "button[type=submit], input[type=submit], input[type=image], button:not([type])",
              );
        if (control && isVisibleInput(control)) {
          if (control instanceof HTMLButtonElement || control instanceof HTMLInputElement) control.click();
          else clickAt(control, false);
          if (await pollFor(submitted, 1500)) method = "control";
        }
      }
      if (!method) {
        return fail("submit_no_effect", "form submission had no observable effect");
      }
      hint = { text: method === "control" ? "submitted via control" : (form.getAttribute("name") ?? undefined) };
      return ok(hint, `submitted via ${method}`);
    }

    case "extract": {
      const text = (target.textContent ?? "").trim().slice(0, 2000);
      return { ok: true, details: text };
    }

    default:
      return fail("out_of_scope", `"${a}" is handled by the browser layer, not the page`);
  }

  return ok(hint);
}

export type PageAction =
  | "click"
  | "type"
  | "scroll"
  | "select"
  | "back"
  | "forward";

export function performAction(command: PageAction, selector?: string, value?: string): void {
  const el = findElement(selector) ?? fallbackElement(command);
  switch (command) {
    case "click": {
      clickAt(el, false);
      break;
    }
    case "type": {
      (el as HTMLElement).focus();
      triggerType(el as HTMLElement, value ?? "");
      break;
    }
    case "select": {
      if (el instanceof HTMLInputElement) el.select();
      (el as HTMLElement).focus();
      break;
    }
    case "scroll": {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      break;
    }
    case "back":
      window.history.back();
      break;
    case "forward":
      window.history.forward();
      break;
  }
}