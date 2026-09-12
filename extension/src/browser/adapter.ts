/* ------------------------------------------------------------------ *
 * BrowserAdapter — the single seam between the agent/platform code and
 * Chrome/Firefox. The agent model, UI and services depend only on this
 * interface; concrete adapters live in chrome.ts / firefox.ts.
 * ------------------------------------------------------------------ */

import type { TabInfo } from "@/shared/runtime";

export type BrowserMessageHandler = (
  message: unknown,
  sender: unknown,
  respond: (reply: unknown) => void,
) => void;

export interface BrowserAdapter {
  readonly runtimeName: "chrome" | "firefox";

  /** Active tab in the current window (with an id), or null. */
  queryActiveTab(): Promise<TabInfo | null>;

  /** All normal tabs in the current window. */
  listTabs(): Promise<TabInfo[]>;

  /** Deliver a payload to a tab's content script if it is ready. */
  sendToTab(tabId: number, payload: unknown): Promise<void>;

  /** Guaranteed delivery — injects the content script on first miss. */
  sendToTabEnsured(tabId: number, payload: unknown): Promise<void>;

  /** RPC round-trip: send a request to the content script and await its reply. */
  sendToTabAndRespond(tabId: number, payload: unknown): Promise<unknown>;

  /** Open a new tab. */
  createTab(url?: string): Promise<TabInfo | null>;

  /** Activate an existing tab. */
  activateTab(tabId: number): Promise<void>;

  /** Close a tab. */
  closeTab(tabId: number): Promise<void>;

  /** Close the active tab. */
  closeActiveTab(): Promise<void>;

  /** Reload a tab. */
  reloadTab(tabId: number): Promise<void>;

  /** Reload the active tab. */
  reloadActiveTab(): Promise<void>;

  /** Navigate a tab to a URL. */
  navigateTab(tabId: number, url: string): Promise<void>;

  /**
   * Page history (relayed to the content script). Resolves true only if a
   * live content script confirmed the command; false when the command could
   * not be delivered (unsupported page, missing content script, bridge down).
   */
  goBackTab(tabId: number): Promise<boolean>;
  goForwardTab(tabId: number): Promise<boolean>;

  /** Open a new window containing the given URL. */
  createWindow(url?: string): Promise<TabInfo | null>;

  /** Read a tab (used for privilege checks and context enrichment). */
  getTab(tabId: number): Promise<TabInfo | null>;

  /**
   * Inject the content script into a tab that does not yet have it
   * (e.g. tabs that were open before the extension installed).
   * Returns true on success.
   */
  injectContentScript(tabId: number): Promise<boolean>;

  /** Panel (side panel in Chrome, sidebar in Firefox). */
  setOpenPanelOnActionClick(): void;
  openPanel(): Promise<void>;

  /** Broadcast a message to every extension context (panels, content scripts). */
  broadcast(message: unknown): Promise<void>;

  /* Events. */
  onActionClicked(cb: () => void): void;
  onInstalled(cb: () => void): void;
  onStartup(cb: () => void): void;
  onMessage(cb: BrowserMessageHandler): void;
  onTabActivated(cb: (tabId: number, windowId: number) => void): void;
  onTabUpdated(cb: (tabId: number, info: { url?: string; status?: string }) => void): void;
  onTabRemoved(cb: (tabId: number) => void): void;
}