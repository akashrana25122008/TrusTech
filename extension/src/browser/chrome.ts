/* ------------------------------------------------------------------ *
 * ChromeAdapter — wraps Chrome's callback-style `chrome` API into the
 * promise-based BrowserAdapter surface.
 * ------------------------------------------------------------------ */

import type { BrowserAdapter, BrowserMessageHandler } from "./adapter";
import type { TabInfo } from "@/shared/runtime";
import { rawApi } from "@/shared/runtime";

const promisify = <R>(fn: (done: (...a: any[]) => void) => void): Promise<R> =>
  new Promise<R>((resolve) => fn((...a: any[]) => resolve(a[0])));

const toTabInfo = (t: any): TabInfo | null =>
  t && t.id != null
    ? { id: t.id as number, url: t.url as string | undefined, title: t.title as string | undefined }
    : null;

export function createChromeAdapter(): BrowserAdapter {
  const api = rawApi();

  const queryActive = (): Promise<TabInfo | null> =>
    promisify<any[]>((done) => api.tabs.query({ active: true, currentWindow: true }, done)).then((tabs) =>
      toTabInfo(tabs?.[0]),
    );

  /** Fire-and-forget delivery. Resolves true if the content script answered. */
  const deliver = (tabId: number, payload: unknown): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      api.tabs.sendMessage(tabId, payload, () => {
        resolve(!api.runtime?.lastError);
      });
    });

  const send = (tabId: number, payload: unknown): Promise<void> =>
    deliver(tabId, payload).then(() => undefined);

  /** Deliver, injecting the content script on first miss. Resolves boolean. */
  const deliverChecked = async (tabId: number, payload: unknown): Promise<boolean> => {
    const delivered = await deliver(tabId, payload);
    if (!delivered && api.scripting) {
      await injectScript(tabId);
      return deliver(tabId, payload);
    }
    return delivered;
  };

  const sendAndRespond = (tabId: number, payload: unknown) =>
    new Promise<unknown>((resolve) => {
      api.tabs.sendMessage(tabId, payload, (res: unknown) => {
        resolve(api.runtime?.lastError
          ? { __error: api.runtime.lastError.message ?? "unknown error" }
          : res);
      });
    });

  /** Inject js/content.js into a tab (pre-install tabs / missed manifest). */
  const injectScript = async (tabId: number): Promise<boolean> => {
    if (!api.scripting) return false;
    try {
      const maybe = api.scripting.executeScript(
        { target: { tabId }, files: ["js/content.js"] },
        () => { void api.runtime?.lastError; },
      );
      // Chromium returns a promise here; Firefox may return void.
      if (maybe && typeof (maybe as Promise<unknown>).then === "function") {
        await (maybe as Promise<unknown>);
      }
      return true;
    } catch {
      return false;
    }
  };

  const get = (tabId: number): Promise<TabInfo | null> =>
    promisify<any>((done) => api.tabs.get(tabId, done)).then((t) => toTabInfo(t));

  return {
    runtimeName: "chrome",

    queryActiveTab: queryActive,

    async listTabs() {
      const tabs = await promisify<any[]>((done) =>
        api.tabs.query({ windowType: "normal" }, done),
      );
      return (tabs ?? []).map(toTabInfo).filter((t): t is TabInfo => t !== null);
    },

    sendToTab: send,

    async sendToTabEnsured(tabId, payload) {
      await deliverChecked(tabId, payload);
    },

    sendToTabAndRespond: sendAndRespond,
    injectContentScript: injectScript,

    async createTab(url) {
      const t = await promisify<any>((done) => api.tabs.create({ url }, done));
      return toTabInfo(t);
    },

    async activateTab(tabId) {
      await promisify<void>((done) => api.tabs.update(tabId, { active: true }, done));
    },

    async closeTab(tabId) {
      await promisify<void>((done) => api.tabs.remove(tabId, done));
    },

    async closeActiveTab() {
      const tab = await queryActive();
      if (tab) await promisify<void>((done) => api.tabs.remove(tab.id, done));
    },

    async reloadTab(tabId) {
      await promisify<void>((done) => api.tabs.reload(tabId, done));
    },

    async reloadActiveTab() {
      const tab = await queryActive();
      if (tab) await promisify<void>((done) => api.tabs.reload(tab.id, done));
    },

    async navigateTab(tabId, url) {
      await promisify<void>((done) => api.tabs.update(tabId, { url }, done));
    },

    async goBackTab(tabId) {
      return deliverChecked(tabId, { type: "AGENT_INJECT_ACTION", payload: { command: "back" } });
    },

    async goForwardTab(tabId) {
      return deliverChecked(tabId, { type: "AGENT_INJECT_ACTION", payload: { command: "forward" } });
    },

    async createWindow(url) {
      const w = await promisify<any>((done) => api.windows.create({ url, state: "normal" }, done));
      return toTabInfo(w?.tabs?.[0] ?? null);
    },

    getTab: get,

    setOpenPanelOnActionClick() {
      try {
        api.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true });
      } catch {
        /* older Chrome */
      }
    },

    async openPanel() {
      try {
        await promisify<void>((done) =>
          api.sidePanel.open({ windowId: api.windows.WINDOW_ID_CURRENT }, done),
        );
      } catch {
        /* noop */
      }
    },

    broadcast(message: unknown): Promise<void> {
      return new Promise<void>((resolve) => {
        try {
          api.runtime?.sendMessage(message, () => {
            // Consume lastError so Chrome does not log it for contexts that
            // answered without an explicit reply.
            void api.runtime?.lastError;
            resolve();
          });
        } catch {
          resolve();
        }
      });
    },

    onActionClicked(cb) {
      api.action?.onClicked?.addListener(cb);
    },
    onInstalled(cb) {
      api.runtime?.onInstalled?.addListener(cb);
    },
    onStartup(cb) {
      api.runtime?.onStartup?.addListener(cb);
    },
    onMessage(cb: BrowserMessageHandler) {
      api.runtime?.onMessage?.addListener((message: unknown, sender: unknown, sendResponse: (x: unknown) => void) => {
        cb(message, sender, sendResponse);
        // Every reply from the worker is async and the router guarantees an
        // answer for every message (claimed or unclaimed), so we keep the
        // channel open by returning true — senders are never left hanging.
        return true;
      });
    },
    onTabActivated(cb) {
      api.tabs?.onActivated?.addListener((a: { tabId: number; windowId: number }) => cb(a.tabId, a.windowId));
    },
    onTabUpdated(cb) {
      api.tabs?.onUpdated?.addListener((tabId: number, info: { url?: string; status?: string }) =>
        cb(tabId, info),
      );
    },
    onTabRemoved(cb) {
      api.tabs?.onRemoved?.addListener((tabId: number) => cb(tabId));
    },
  };
}