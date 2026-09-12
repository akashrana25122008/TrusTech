/* ------------------------------------------------------------------ *
 * Browser adapter factory. Also exposes a safe no-op adapter so the UI
 * can be developed in a plain page (vite preview) without breaking.
 * ------------------------------------------------------------------ */

import type { BrowserAdapter } from "./adapter";
import { createChromeAdapter } from "./chrome";
import { createFirefoxAdapter } from "./firefox";
import { isFirefoxRuntime } from "@/shared/runtime";

const NOOP_ADAPTER: BrowserAdapter = {
  runtimeName: "chrome",
  queryActiveTab: async () => null,
  listTabs: async () => [],
  sendToTab: async () => undefined,
  sendToTabEnsured: async () => undefined,
  sendToTabAndRespond: async () => undefined,
  createTab: async () => null,
  activateTab: async () => undefined,
  closeTab: async () => undefined,
  closeActiveTab: async () => undefined,
  reloadTab: async () => undefined,
  reloadActiveTab: async () => undefined,
  navigateTab: async () => undefined,
  goBackTab: async () => true,
  goForwardTab: async () => true,
  createWindow: async () => null,
  getTab: async () => null,
  injectContentScript: async () => false,
  setOpenPanelOnActionClick: () => undefined,
  openPanel: async () => undefined,
  broadcast: async () => undefined,
  onActionClicked: () => undefined,
  onInstalled: () => undefined,
  onStartup: () => undefined,
  onMessage: () => undefined,
  onTabActivated: () => undefined,
  onTabUpdated: () => undefined,
  onTabRemoved: () => undefined,
};

export function getBrowserAdapter(forceRuntime?: "chrome" | "firefox"): BrowserAdapter {
  if (forceRuntime) {
    return forceRuntime === "firefox" ? createFirefoxAdapter() : createChromeAdapter();
  }
  if (isFirefoxRuntime()) return createFirefoxAdapter();
  try {
    return createChromeAdapter();
  } catch {
    return NOOP_ADAPTER;
  }
}

export type { BrowserAdapter, BrowserMessageHandler } from "./adapter";