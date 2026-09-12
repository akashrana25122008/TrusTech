/* ------------------------------------------------------------------ *
 * TabService — tab-level browser control. Page-level actions
 * (click/type/scroll/…/back/forward) are forwarded to the content
 * script; the rest are performed by the extension API directly.
 * ------------------------------------------------------------------ */

import type { BrowserAdapter } from "@/browser";
import type { InjectActionCommand } from "@/shared/types";

const TAB_COMMANDS: ReadonlySet<string> = new Set<InjectActionCommand>([
  "newTab",
  "closeTab",
  "reload",
]);

export class TabService {
  constructor(private readonly adapter: BrowserAdapter) {}

  async executeTabCommand(command: InjectActionCommand): Promise<void> {
    switch (command) {
      case "newTab":
        await this.adapter.createTab();
        return;
      case "closeTab":
        await this.adapter.closeActiveTab();
        return;
      case "reload":
        await this.adapter.reloadActiveTab();
        return;
      default:
        throw new Error(`[TrusTech] ${command} is not a tab-level command`);
    }
  }

  /** Forward any agent/command payload to the active tab with on-demand injection. */
  async broadcastToActiveTab(payload: Record<string, unknown>): Promise<void> {
    const tab = await this.adapter.queryActiveTab();
    if (!tab) return;
    await this.adapter.sendToTabEnsured(tab.id, payload);
  }

  /** Route a BROWSER_COMMAND: tab-level here, page-level to the content script. */
  async handleBrowserCommand(command: InjectActionCommand): Promise<void> {
    if (TAB_COMMANDS.has(command)) {
      await this.executeTabCommand(command);
      return;
    }
    await this.broadcastToActiveTab({
      type: "AGENT_INJECT_ACTION",
      payload: { command },
    });
  }
}