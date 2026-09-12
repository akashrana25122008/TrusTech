/* ------------------------------------------------------------------ *
 * Accessibility reader — ARIA roles, accessible names, label
 * association and interaction state, plus pragmatic tag-based inference
 * when ARIA is absent.
 * ------------------------------------------------------------------ */

import type { IndexedElement } from "@/shared/messages";

const ROLE_FALLBACK: Record<string, string> = {
  A: "link",
  BUTTON: "button",
  TEXTAREA: "textbox",
  SELECT: "combobox",
};

export function inferRole(el: Element): string {
  const explicit = el.getAttribute("role");
  if (explicit) return explicit;

  if (el instanceof HTMLInputElement) {
    const t = el.type;
    if (t === "checkbox") return "checkbox";
    if (t === "radio") return "radio";
    if (t === "submit" || t === "button") return "button";
    if (t === "search") return "searchbox";
    return "textbox";
  }
  const fallback = ROLE_FALLBACK[el.tagName];
  if (fallback) return fallback;
  if ((el as HTMLElement).isContentEditable) return "textbox";
  if (el.tagName === "H1" || el.tagName === "H2" || el.tagName === "H3") return "heading";
  return "generic";
}

/** Accessible name: aria-labelledby → aria-label → title → text content → placeholder. */
export function accessibleName(el: Element): string {
  const labelledby = el.getAttribute("aria-labelledby");
  if (labelledby) {
    const ref = document.getElementById(labelledby.split(/\s+/)[0]);
    const text = ref?.textContent?.trim();
    if (text) return text;
  }
  const label = el.getAttribute("aria-label");
  if (label?.trim()) return label.trim();

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    if (el.labels) {
      const labelText = Array.from(el.labels)
        .map((l) => l.textContent?.trim() ?? "")
        .filter(Boolean)
        .join(" ");
      if (labelText) return labelText;
    }
    if (el.getAttribute("aria-placeholder")?.trim()) return el.getAttribute("aria-placeholder")!.trim();
    const placeholder = el.getAttribute("placeholder");
    if (placeholder?.trim()) return placeholder.trim();
    const title = el.getAttribute("title");
    if (title?.trim()) return title.trim();
    return "";
  }

  const title = el.getAttribute("title");
  if (title?.trim()) return title.trim();

  const text = (el.textContent ?? "").trim();
  return text.slice(0, 120);
}

export function isVisible(el: Element): boolean {
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  if (el instanceof HTMLElement) {
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
  }
  return true;
}

export function isEnabled(el: Element): boolean {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || el instanceof HTMLButtonElement) {
    return !el.disabled;
  }
  return el.getAttribute("aria-disabled") !== "true";
}

/** Compact readable summary of one element for an observation. */
export function readElement(el: Element, id: string): IndexedElement {
  const rect = el.getBoundingClientRect();
  const text = (el.textContent ?? "").trim();
  const ownText = (el.getAttribute?.("aria-label") ?? text).trim().slice(0, 80) || "";

  return {
    id,
    role: inferRole(el),
    name: accessibleName(el),
    tag: el.tagName.toLowerCase(),
    type: el instanceof HTMLInputElement ? el.type : undefined,
    visible: isVisible(el),
    enabled: isEnabled(el),
    focused: document.activeElement === el,
    checked: el instanceof HTMLInputElement ? el.checked : undefined,
    selected:
      el instanceof HTMLOptionElement ? el.selected
      : el instanceof HTMLSelectElement ? el.selectedIndex >= 0
      : el.getAttribute("aria-selected") === "true",
    text: ownText || text.slice(0, 80),
    value:
      el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement
        ? (el.value ?? "").slice(0, 200)
        : undefined,
    rect: { x: rect.left, y: rect.top, w: rect.width, h: rect.height },
  };
}