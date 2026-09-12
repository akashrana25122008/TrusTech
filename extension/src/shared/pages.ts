/* ------------------------------------------------------------------ *
 * Page/URL support helpers — the agent must never attempt to message
 * browser-internal or otherwise un-injectable pages (chrome://, edge://,
 * about:, extension pages, view-source, devtools, …). Content scripts
 * cannot run there, and tabs.sendMessage throws a stale "receiving end
 * does not exist" for them. We classify URLs before ever messaging.
 * ------------------------------------------------------------------ */

export type PageSupport = "controllable" | "unsupported" | "unknown";

const UNSUPPORTED_SCHEMES = [
  "chrome://",
  "chrome-extension://",
  "moz-extension://",
  "edge://",
  "about:",
  "devtools://",
  "view-source:",
  "data:",
  "javascript:",
  "chrome-newtab://",
];

/** Is this a URL we can control with a content script at all? */
export function pageUrlSupport(url?: string): PageSupport {
  if (!url || typeof url !== "string") return "unknown";
  const trimmed = url.trim();
  if (!trimmed) return "unknown";
  const lower = trimmed.toLowerCase();
  for (const scheme of UNSUPPORTED_SCHEMES) {
    if (lower.startsWith(scheme)) return "unsupported";
  }
  // Only http/https (and optionally file) pages can host our content script.
  if (/^https?:\/\//i.test(trimmed)) return "controllable";
  return "unsupported";
}

export function isControllablePageUrl(url?: string): boolean {
  return pageUrlSupport(url) === "controllable";
}

export function isUnsupportedPageUrl(url?: string): boolean {
  return pageUrlSupport(url) === "unsupported";
}

import type { ActionName } from "./action-schema";

/** Human guidance shown when the user's active tab cannot be driven. */
export const CONTROLLABLE_PAGE_HINT =
  "Browser page cannot be controlled. Open a regular webpage to continue.";

/* ------------------------------------------------------------------ *
 * Capability model — browser-level and page-level controllability are
 * NOT the same thing.
 *
 *   chrome://newtab/          browser ✅  page ❌
 *   https://www.youtube.com   browser ✅  page ✅
 *
 * Browser-level actions (navigate, tabs, reload, …) need only a live
 * tab, so they work on internal pages. Page-level actions (observe,
 * click, type, …) need a scriptable page. Terminal actions (finish,
 * ask_user) need neither — they resolve the task, not the page.
 * ------------------------------------------------------------------ */

/** Browser-level: tab chrome works, no DOM needed. */
export const BROWSER_LEVEL_ACTIONS: ReadonlySet<ActionName> = new Set([
  "navigate",
  "new_tab",
  "close_tab",
  "switch_tab",
  "back",
  "forward",
  "reload",
]);

/** Terminal: task resolution, not page interaction. */
export const TERMINAL_ACTIONS: ReadonlySet<ActionName> = new Set([
  "finish",
  "ask_user",
]);

export type CapabilityLevel = "browser" | "page" | "terminal";

/** Which capability level an action requires. */
export function actionCapabilityLevel(name: ActionName): CapabilityLevel {
  if (BROWSER_LEVEL_ACTIONS.has(name)) return "browser";
  if (TERMINAL_ACTIONS.has(name)) return "terminal";
  return "page";
}

export interface PageCapability {
  /** Tab chrome works (navigate, tabs, reload…). True whenever a tab exists. */
  browser: boolean;
  /** DOM control works (observe, click, type…). False on internal pages. */
  page: boolean;
}

/** Capability of a tab by URL. A tab always offers browser-level control;
 *  only scriptable (http/https) pages offer page-level control. */
export function pageCapability(url?: string): PageCapability {
  return { browser: true, page: isControllablePageUrl(url) };
}

/** Browser-level control needs only a live tab — works on chrome://newtab/. */
export function isBrowserControllable(hasTab: boolean): boolean {
  return hasTab;
}

/** Page-level control needs a scriptable page. */
export function isPageControllable(url?: string): boolean {
  return isControllablePageUrl(url);
}