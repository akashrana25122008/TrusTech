/* ------------------------------------------------------------------ *
 * DOM reader — builds the compact structured observation. Never sends
 * raw HTML to the reasoning layer; filters to what the task needs.
 * ------------------------------------------------------------------ */

import type { ObservationSnapshot, IndexedElement } from "@/shared/messages";
import { indexAll, idOf, indexElement } from "./indexer";
import { readElement } from "./accessibility-reader";

export const MAX_ELEMENTS = 60;
export const MAX_TEXT = 6000;

const INPUT_SELECTOR =
  'input[type="search"], input[type="text"], textarea, [contenteditable="true"], [role="searchbox"]';

function pageType(): string {
  const docText = (document.body?.textContent ?? "").slice(0, 3000).toLowerCase();
  const hasSearch = document.querySelector(INPUT_SELECTOR) !== null;
  const hasResults =
    document.querySelectorAll('a[href*="/results"], [data-testid="result"], ul li, .search-result, [class*="result"]').length > 0;
  if (/shopping|price|compare|buy now|add to cart/.test(docText)) return "commerce";
  if (hasSearch) return "search";
  if (hasResults) return "results";
  return "content";
}

/** Visible text — innerText is layout-resolved and naturally compact. */
function visibleText(): string {
  const text = document.body?.innerText ?? "";
  return text.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
}

export function buildObservation(tabId: number): ObservationSnapshot {
  const elements = indexAll(document);
  const view = { w: window.innerWidth, h: window.innerHeight };

  const indexed: IndexedElement[] = [];
  for (const el of elements) {
    if (indexed.length >= MAX_ELEMENTS) break;
    const id = idOf(el) ?? indexElement(el);
    indexed.push(readElement(el, id));
  }

  return {
    url: location.href,
    title: document.title,
    tabId,
    pageType: pageType(),
    viewport: view,
    scrollY: window.scrollY,
    scrollH: Math.max(window.scrollY, document.documentElement.scrollHeight - view.h),
    loading: document.readyState !== "complete",
    visibleText: visibleText(),
    elements: indexed,
    counted: elements.length,
    createdAt: Date.now(),
  };
}