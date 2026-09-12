/* ------------------------------------------------------------------ *
 * NavigationManager — browser-level navigation primitives used by the
 * agent (navigate / back / forward / reload). Page-level actions stay
 * in the content script; these are the adapter-level needs.
 * ------------------------------------------------------------------ */

import type { BrowserAdapter } from "@/browser";

export interface NavigationResult {
  ok: boolean;
  error?: string;
}

export class NavigationManager {
  constructor(private readonly adapter: BrowserAdapter) {}

  private async run(fn: () => Promise<void>): Promise<NavigationResult> {
    try {
      await fn();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Runs a boolean-returning primitive; false means the bridge was down. */
  private async runBool(fn: () => Promise<boolean>): Promise<NavigationResult> {
    try {
      const delivered = await fn();
      return delivered ? { ok: true } : { ok: false, error: "content_script_not_ready" };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  navigate(tabId: number, url: string): Promise<NavigationResult> {
    return this.run(() => this.adapter.navigateTab(tabId, url));
  }

  back(tabId: number): Promise<NavigationResult> {
    return this.runBool(() => this.adapter.goBackTab(tabId));
  }

  forward(tabId: number): Promise<NavigationResult> {
    return this.runBool(() => this.adapter.goForwardTab(tabId));
  }

  reload(tabId: number): Promise<NavigationResult> {
    return this.run(() => this.adapter.reloadTab(tabId));
  }
}