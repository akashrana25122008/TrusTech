/* ------------------------------------------------------------------ *
 * TrusTech background service worker (MV3 / Firefox).
 * Composes platform services — tabs, panels, message routing — behind
 * the BrowserAdapter so the worker never touches `chrome` directly.
 * ------------------------------------------------------------------ */

import { getBrowserAdapter } from "@/browser";
import { MessageRouter } from "./router";
import { ContentChannel } from "./content-channel";
import { TabService } from "./tabs";
import { PanelsService } from "./panels";
import { TabManager } from "./tab-manager";
import { NavigationManager } from "./navigation-manager";
import { WindowManager } from "./window-manager";

const adapter = getBrowserAdapter();

/* ---- services ---- */
const panels = new PanelsService(adapter);
const tabs = new TabService(adapter);
const tabMgr = new TabManager(adapter);
const nav = new NavigationManager(adapter);
const win = new WindowManager(adapter);
const content = new ContentChannel(adapter);
const router = new MessageRouter(tabs, tabMgr, nav, win, adapter, content);

/* ---- lifecycle ---- */
adapter.onInstalled(async () => {
  panels.install();
  await tabMgr.refresh();
});
adapter.onStartup(async () => {
  panels.install();
  await tabMgr.refresh();
});

/* ---- background forwards events to all panels (runtime broadcast) ---- */
function sendPanelEvent(event: unknown): void {
  panels.broadcast(event);
}

/* ---- panel <-> tab routing ---- */
adapter.onMessage((message, sender, respond) => {
  // The router guarantees an answer for every message (claimed or not),
  // so a caller's response promise is never left open (see router.handle).
  void router.handle(message, sender, respond, sendPanelEvent);
});

/* ---- tab lifecycle: invalidate the ContentChannel on navigation / close ---- */
adapter.onTabUpdated((tabId, changeInfo) => {
  content.onTabUpdated(tabId, changeInfo);
});

adapter.onTabRemoved((tabId) => {
  content.invalidate(tabId);
});

export {};
