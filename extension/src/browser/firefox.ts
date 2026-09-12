/* ------------------------------------------------------------------ *
 * FirefoxAdapter — Firefox exposes a native promise-based `browser`
 * namespace (plus the callback `chrome` alias). Side panel is served by
 * `browser.sidebarAction`. Everything else delegates to ChromeAdapter.
 * ------------------------------------------------------------------ */

import type { BrowserAdapter, BrowserMessageHandler } from "./adapter";
import { createChromeAdapter } from "./chrome";
import { rawApi } from "@/shared/runtime";

export function createFirefoxAdapter(): BrowserAdapter {
  const base = createChromeAdapter();
  const api = rawApi();

  return {
    ...base,
    runtimeName: "firefox",

    setOpenPanelOnActionClick() {
      try {
        // Firefox: open the sidebar whenever the toolbar action is clicked.
        api.sidebarAction?.open?.();
      } catch {
        /* noop */
      }
    },

    async openPanel() {
      try {
        await api.sidebarAction.open();
      } catch {
        /* noop */
      }
    },

    onMessage(cb: BrowserMessageHandler) {
      // Firefox listeners may return a Promise that resolves the response.
      api.runtime?.onMessage?.addListener((message: unknown, sender: unknown, sendResponse: (x: unknown) => void) => {
        cb(message, sender, sendResponse);
        return true;
      });
    },
  };
}