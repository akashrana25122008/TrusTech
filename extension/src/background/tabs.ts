/* ------------------------------------------------------------------ *
 * TabService — tab-level browser control. Page-level actions
 * (click/type/scroll/…/back/forward) are forwarded to the content
 * script; the rest are performed by the extension API directly.
 * ------------------------------------------------------------------ */

import type { BrowserAdapter } from "@/browser";

export class TabService {
  constructor(private readonly adapter: BrowserAdapter) {}

  /** Forward any agent/command payload to the active tab with on-demand injection. */
  async broadcastToActiveTab(payload: Record<string, unknown>): Promise<void> {
    const tab = await this.adapter.queryActiveTab();
    if (!tab) return;
    await this.adapter.sendToTabEnsured(tab.id, payload);
  }
}