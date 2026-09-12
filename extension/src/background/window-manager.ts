/* ------------------------------------------------------------------ *
 * WindowManager — multi-tab / multi-window strategy primitives.
 * ------------------------------------------------------------------ */

import type { BrowserAdapter } from "@/browser";
import type { TabInfo } from "@/shared/runtime";

export class WindowManager {
  constructor(private readonly adapter: BrowserAdapter) {}

  async openTab(url?: string): Promise<TabInfo | null> {
    return this.adapter.createTab(url);
  }

  async openWindow(url?: string): Promise<TabInfo | null> {
    return this.adapter.createWindow(url);
  }

  async activate(tabId: number): Promise<void> {
    await this.adapter.activateTab(tabId);
  }

  async close(tabId: number): Promise<void> {
    await this.adapter.closeTab(tabId);
  }

  async list(): Promise<TabInfo[]> {
    return this.adapter.listTabs();
  }
}