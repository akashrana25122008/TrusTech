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

function ok(hint?: ActionResult["hint"]): ActionResult {
  return { ok: true, hint };
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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function executeAction(action: AgentAction, groundedId?: string): Promise<ActionResult> {
  const a = action.action;

  if (a === "wait") {
    await sleep(Math.min(Math.max(action.ms ?? 500, 0), 10_000));
    return ok();
  }

  // press_key acts on the focused element (the query the agent just typed
  // into) and needs no indexed target — requiring one made every real
  // Enter submission fail as "missing_target" before touching the DOM.
  if (a === "press_key") {
    const active = (document.activeElement as HTMLElement | null) ?? document.body;
    active.dispatchEvent(
      new KeyboardEvent("keydown", { key: action.key, bubbles: true, cancelable: true }),
    );
    if (action.key === "Enter" && active instanceof HTMLButtonElement) {
      active.click();
    }
    active.dispatchEvent(new KeyboardEvent("keyup", { key: action.key, bubbles: true }));
    if (action.key === "Escape" && "blur" in active) (active as HTMLElement).blur();
    return ok();
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
      if (form) {
        form.requestSubmit?.();
        hint = { text: form.getAttribute("name") ?? undefined };
      } else {
        return fail("invalid_target", "submit requires a form");
      }
      break;
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