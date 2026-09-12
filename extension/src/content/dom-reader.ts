/* ------------------------------------------------------------------ *
 * DOM reader — builds the compact structured observation. Never sends
 * raw HTML to the reasoning layer; filters to what the task needs.
 * ------------------------------------------------------------------ */

import type { ObservationSnapshot, IndexedElement } from "@/shared/messages";
import { indexAll, idOf, indexElement } from "./indexer";
import { readElement } from "./accessibility-reader";

/**
 * Snapshot budget: matches the backend StepObservation element cap so the
 * full snapshot is always transmittable. Content-heavy pages (search
 * results, feeds) otherwise expose only their header chrome.
 */
export const MAX_ELEMENTS = 100;
export const MAX_TEXT = 6000;

/** Site chrome landmarks — real content first, chrome last (generic ARIA/HTML, never site tags). */
const CHROME_SELECTOR = "[role=banner], header, nav, footer, [role=navigation], [role=contentinfo]";
/** Main content landmark — task targets overwhelmingly live here. */
const MAIN_SELECTOR = "main, [role=main]";

function inChrome(el: Element): boolean {
  try {
    return el.closest(CHROME_SELECTOR) !== null;
  } catch {
    return false;
  }
}

function inMain(el: Element): boolean {
  try {
    return el.closest(MAIN_SELECTOR) !== null;
  } catch {
    return false;
  }
}

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

  // Deterministic content-first order (verified live: DOM-order truncation
  // kept only header chrome on result pages, hiding every video link):
  // main content, then neutral regions, then site chrome landmarks.
  // Within each tier DOM order is preserved, so small pages are untouched.
  const main = elements.filter((el) => inMain(el));
  const rest = elements.filter((el) => !inMain(el) && !inChrome(el));
  const chrome = elements.filter((el) => !inMain(el) && inChrome(el));
  const indexed: IndexedElement[] = [];
  for (const el of [...main, ...rest, ...chrome]) {
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