/* ------------------------------------------------------------------ *
 * Element indexer — assigns temporary agent ids (el_001…) to relevant
 * interactive elements. Ids are NOT permanent: after meaningful DOM
 * mutation the page is re-observed, re-indexed and re-grounded, and a
 * stale id must never execute.
 * ------------------------------------------------------------------ */

export const INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "input",
  "textarea",
  "select",
  "[contenteditable='true']",
  "[role='button']",
  "[role='link']",
  "[role='textbox']",
  "[role='searchbox']",
  "[role='checkbox']",
  "[role='radio']",
  "[role='combobox']",
  "[role='listbox']",
  "[role='option']",
  "[role='tab']",
  "[role='menuitem']",
  "h1",
  "h2",
  "h3",
].join(",");

const indexMapHolder: { map: WeakMap<Element, string> } = { map: new WeakMap() };
const byId = new Map<string, Element>();
let seq = 1;

export function indexElement(el: Element): string {
  const existing = indexMapHolder.map.get(el);
  if (existing) return existing;
  const id = `el_${String(seq++).padStart(3, "0")}`;
  indexMapHolder.map.set(el, id);
  byId.set(id, el);
  return id;
}

/** Index every interactive candidate in a root, returning them in DOM order. */
export function indexAll(root: ParentNode = document): Element[] {
  const els = Array.from(root.querySelectorAll<Element>(INTERACTIVE_SELECTOR));
  els.forEach((el) => indexElement(el));
  return els;
}

export function resolveId(id: string): Element | null {
  return byId.get(id) ?? null;
}

/** Element still attached to the live document? */
export function isLive(id: string, root: ParentNode = document): boolean {
  const el = byId.get(id);
  return el !== undefined && root.contains(el);
}

export function indexSize(): number {
  return byId.size;
}

/** Id currently assigned to an element, if any. */
export function idOf(el: Element): string | undefined {
  return indexMapHolder.map.get(el);
}

export function clearIndex(): void {
  // Both directions must drop: byId alone is not enough. indexElement
  // returns the cached id for a known element WITHOUT re-registering it,
  // so a surviving element would keep advertising an id that resolveId
  // can no longer find — every grounded action would fail as "not_found"
  // on mutation-heavy pages (YouTube) until the next full reload.
  byId.clear();
  indexMapHolder.map = new WeakMap();
  seq = 1;
}