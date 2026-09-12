/* ------------------------------------------------------------------ *
 * PanelTransportAdapter — the side panel sees the browser through the
 * SAME BrowserAdapter interface the controller expects. Page RPC is
 * relayed through the service worker to the content script. Outside a
 * real extension this adapter is unavailable and the UI falls back to
 * the simulator.
 * ------------------------------------------------------------------ */

import type { BrowserAdapter, BrowserMessageHandler } from "./adapter";
import type { TabInfo } from "@/shared/runtime";
import { rawApi } from "@/shared/runtime";

const noop = () => undefined;
const nothing = async () => undefined;

/** Throw unless the background confirmed the browser operation. */
function assertBrowserOk(res: { ok?: boolean; error?: string } | null, op: string): void {
  if (!res || res.ok !== true) {
    const detail = typeof res?.error === "string" && res.error.length > 0 ? `: ${res.error}` : "";
    throw new Error(`${op}_failed${detail}`);
  }
}

export class PanelTransportAdapter implements BrowserAdapter {
  readonly runtimeName = "chrome" as const;

  private handlers = new Set<BrowserMessageHandler>();
  private listenerBound = false;
  private api: any;
  private _ready: boolean;

  constructor() {
    this._ready = false;
    try {
      this.api = rawApi();
      this._ready = Boolean(this.api?.runtime?.sendMessage);
    } catch {
      this._ready = false;
    }
  }

  get ready(): boolean {
    return this._ready;
  }

  /**
   * Inbound event subscription: background broadcast (EVENT_TAB_*,
   * EVENT_PAGE_CHANGED) arrives via runtime.onMessage. Registered once;
   * every subscriber sees each event (event dispatch is one-way).
   */
  private subscribe(cb: BrowserMessageHandler): void {
    this.handlers.add(cb);
    if (this.listenerBound || !this.api?.runtime?.onMessage?.addListener) return;
    this.listenerBound = true;
    this.api.runtime.onMessage.addListener((message: unknown, sender: unknown, sendResponse: (x: unknown) => void) => {
      for (const h of this.handlers) h(message, sender, sendResponse);
      return false;
    });
  }

  private rpc(payload: unknown): Promise<unknown> {
    if (!this._ready) return Promise.reject(new Error("NO_EXTENSION"));
    return new Promise((resolve) => {
      this.api.runtime.sendMessage(payload, (res: unknown) => {
        if (this.api.runtime.lastError) resolve({ __error: this.api.runtime.lastError.message });
        else resolve(res);
      });
    });
  }

  private async browserCommand(payload: { command: string; tabId?: number; url?: string }): Promise<{
    ok?: boolean;
    error?: string;
    tabId?: number;
  }> {
    const res = (await this.rpc({ type: "BROWSER_COMMAND", payload })) as {
      ok?: boolean;
      error?: string;
      tabId?: number;
      __error?: string;
    } | null;
    if (res && typeof res.__error === "string") throw new Error(res.__error);
    return res ?? {};
  }

  queryActiveTab = async (): Promise<TabInfo | null> => {
    const res = (await this.rpc({ type: "QUERY_ACTIVE_TAB" })) as { id: number; url?: string; title?: string } | null;
    return res ? { id: res.id, url: res.url, title: res.title } : null;
  };

  listTabs = async (): Promise<TabInfo[]> => {
    const res = (await this.rpc({ type: "LIST_TABS" })) as Array<{ id: number; url?: string; title?: string }>;
    return Array.isArray(res) ? res.map((t) => ({ id: t.id, url: t.url, title: t.title })) : [];
  };

  sendToTab = nothing;
  sendToTabEnsured = nothing;
  sendToTabAndRespond = (_tabId: number, payload: unknown): Promise<unknown> => this.rpc(payload);

  createTab = async (url?: string): Promise<TabInfo | null> => {
    const res = (await this.rpc({ type: "BROWSER_COMMAND", payload: { command: "newTab", url } })) as {
      ok?: boolean;
      tabId?: number;
      url?: string;
    };
    return res?.tabId ? { id: res.tabId, url: res.url, title: undefined } : null;
  };

  activateTab = async (tabId: number): Promise<void> => {
    const res = await this.browserCommand({ command: "switchTab", tabId });
    assertBrowserOk(res, "switchTab");
  };
  closeTab = async (tabId: number): Promise<void> => {
    const res = await this.browserCommand({ command: "closeTab", tabId });
    assertBrowserOk(res, "closeTab");
  };
  closeActiveTab = async (): Promise<void> => {
    const res = await this.browserCommand({ command: "closeTab" });
    assertBrowserOk(res, "closeTab");
  };
  reloadTab = async (tabId: number): Promise<void> => {
    const res = await this.browserCommand({ command: "reload", tabId });
    assertBrowserOk(res, "reload");
  };
  reloadActiveTab = async (): Promise<void> => {
    const res = await this.browserCommand({ command: "reload" });
    assertBrowserOk(res, "reload");
  };
  navigateTab = async (tabId: number, url: string): Promise<void> => {
    const res = await this.browserCommand({ command: "navigate", tabId, url });
    assertBrowserOk(res, "navigate");
  };
  goBackTab = async (tabId: number): Promise<boolean> => {
    try {
      const res = await this.browserCommand({ command: "back", tabId });
      return res?.ok === true;
    } catch {
      return false;
    }
  };
  goForwardTab = async (tabId: number): Promise<boolean> => {
    try {
      const res = await this.browserCommand({ command: "forward", tabId });
      return res?.ok === true;
    } catch {
      return false;
    }
  };
  createWindow = async (url?: string): Promise<TabInfo | null> => {
    const res = (await this.rpc({
      type: "BROWSER_COMMAND",
      payload: { command: "newWindow", url },
    })) as { ok?: boolean; tabId?: number; url?: string };
    return res?.tabId ? { id: res.tabId, url: res.url, title: undefined } : null;
  };
  getTab = async (tabId: number): Promise<TabInfo | null> => {
    const res = (await this.rpc({ type: "GET_TAB", payload: { tabId } })) as {
      id: number;
      url?: string;
      title?: string;
    } | null;
    return res ? { id: res.id, url: res.url, title: res.title } : null;
  };

  injectContentScript = async (tabId: number): Promise<boolean> => {
    const res = (await this.rpc({ type: "INJECT_CONTENT_SCRIPT", payload: { tabId } })) as { ok?: boolean } | null;
    return Boolean(res?.ok);
  };

  setOpenPanelOnActionClick = noop;
  openPanel = nothing;
  broadcast = nothing;
  onActionClicked = noop;
  onInstalled = noop;
  onStartup = noop;
  onMessage = (cb: BrowserMessageHandler): void => this.subscribe(cb);
  onTabActivated = noop;
  onTabUpdated = noop;
  onTabRemoved = noop;
}