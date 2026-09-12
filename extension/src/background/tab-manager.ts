/* ------------------------------------------------------------------ *
 * TabManager — tracks open tabs (purpose map) and relays tab-switch /
 * update / close signals so the agent knows which context is live.
 * ------------------------------------------------------------------ */

import type { BrowserAdapter } from "@/browser";

export interface AgentTabContext {
  tabId: number;
  url?: string;
  active: boolean;
  /** Human purpose assigned by the task interpreter (e.g. "results-1"). */
  purpose?: string;
}

export class TabManager {
  private tabs = new Map<number, AgentTabContext>();

  constructor(private readonly adapter: BrowserAdapter) {
    this.adapter.onTabActivated((tabId) => {
      for (const ctx of this.tabs.values()) ctx.active = ctx.tabId === tabId;
      const ctx = this.tabs.get(tabId);
      if (ctx) ctx.active = true;
    });
    this.adapter.onTabUpdated((tabId, info) => {
      const ctx = this.tabs.get(tabId);
      if (ctx && info.url) ctx.url = info.url;
    });
    this.adapter.onTabRemoved((tabId) => {
      this.tabs.delete(tabId);
    });
  }

  async refresh(): Promise<void> {
    const tabs = await this.adapter.listTabs();
    const active = await this.adapter.queryActiveTab();
    this.tabs.clear();
    for (const t of tabs) {
      this.tabs.set(t.id, {
        tabId: t.id,
        url: t.url,
        active: t.id === active?.id,
      });
    }
  }

  registerPurpose(tabId: number, purpose: string): void {
    const ctx = this.tabs.get(tabId);
    if (ctx) ctx.purpose = purpose;
  }

  /**
   * Current active tab context — the agent's live reality.
   * Warm path: the in-memory context (fast for steady-state RPCs).
   * Cold path (SW restart / first call): drives from the adapter so the
   * controller never executes against a stale context.
   */
  async active(): Promise<AgentTabContext | null> {
    const cached = this.findActive();
    if (cached) return cached;

    const tab = await this.adapter.queryActiveTab();
    if (!tab) return null;

    const existing = this.tabs.get(tab.id);
    const ctx: AgentTabContext = {
      tabId: tab.id,
      url: tab.url,
      active: true,
      purpose: existing?.purpose,
    };
    this.tabs.set(tab.id, ctx);
    for (const other of this.tabs.values()) if (other.tabId !== tab.id) other.active = false;
    return ctx;
  }

  private findActive(): AgentTabContext | null {
    for (const ctx of this.tabs.values()) if (ctx.active) return ctx;
    return null;
  }

  byId(tabId: number): AgentTabContext | undefined {
    return this.tabs.get(tabId);
  }
}