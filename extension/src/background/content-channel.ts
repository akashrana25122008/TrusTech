/* ------------------------------------------------------------------ *
 * ContentChannel — manages the "is a content script live on this tab?"
 * state. The router uses this before every CTX_* relay so that the
 * extension never fires tabs.sendMessage on a cold tab or an
 * unsupported page (chrome://, about:, …).
 *
 * Lifecycle:
 *   1. Content script inits → sends CONTENT_READY → we mark ready.
 *   2. On CTX_* relay the router calls ensure(tabId) which:
 *        a. Validates the tab URL (unsupported → hard reject).
 *        b. If already ready → return true.
 *        c. Pings the tab (CTX_PING). If it answers → mark ready.
 *        d. If ping fails → injectContentScript → re-ping.
 *   3. On tab navigation / reload we invalidate (remove) the tab.
 * ------------------------------------------------------------------ */

import type { BrowserAdapter } from "@/browser";
import type { ContentErrorCode } from "@/shared/messages";
import { isControllablePageUrl, isUnsupportedPageUrl } from "@/shared/pages";

export interface EnsureResult {
  ok: boolean;
  code?: ContentErrorCode;
  message?: string;
}

export class ContentChannel {
  private ready = new Set<number>();

  constructor(private readonly adapter: BrowserAdapter) {}

  /** Mark a tab as ready (called from the router when CONTENT_READY arrives). */
  markReady(tabId: number): void {
    this.ready.add(tabId);
  }

  /** Drop readiness — called on tab navigation, reload, or close. */
  invalidate(tabId: number): void {
    this.ready.delete(tabId);
  }

  /** Quick check — no side effects. */
  isReady(tabId: number): boolean {
    return this.ready.has(tabId);
  }

  /**
   * Ensure a content script is reachable on `tabId`.
   *
   * 1. Fetch the tab info.
   * 2. Reject unsupported URLs immediately (chrome://, edge://, …).
   * 3. If already ready → ok.
   * 4. CTX_PING the tab. If it answers → ok.
   * 5. Inject the content script, re-ping. If still no → fail.
   */
  async ensure(tabId: number): Promise<EnsureResult> {
    const tab = await this.adapter.getTab(tabId);
    const url = tab?.url;

    if (url != null && isUnsupportedPageUrl(url)) {
      return { ok: false, code: "unsupported_page", message: "Browser page cannot be controlled. Open a regular webpage to continue." };
    }
    if (url != null && !isControllablePageUrl(url)) {
      return { ok: false, code: "unsupported_page", message: "Browser page cannot be controlled. Open a regular webpage to continue." };
    }

    // Already confirmed ready in a previous handshake.
    if (this.ready.has(tabId)) return { ok: true };

    // Try pinging the content script directly.
    const pingOk = await this.ping(tabId);
    if (pingOk) {
      this.ready.add(tabId);
      return { ok: true };
    }

    // Not injected yet (pre-install open tabs or missed nav).
    const injected = await this.adapter.injectContentScript(tabId);
    if (!injected) {
      return { ok: false, code: "content_script_not_ready", message: "Could not inject agent into this page." };
    }

    // Re-ping after injection.
    const secondPing = await this.ping(tabId);
    if (secondPing) {
      this.ready.add(tabId);
      return { ok: true };
    }

    return { ok: false, code: "content_script_not_ready", message: "Agent content script did not respond after injection." };
  }

  /** Fire CTX_PING and wait for CTX_PONG — returns true if answered. */
  async ping(tabId: number): Promise<boolean> {
    try {
      const reply = await this.adapter.sendToTabAndRespond(tabId, { type: "CTX_PING" }) as { type?: string } | undefined;
      return reply?.type === "CTX_PONG";
    } catch {
      return false;
    }
  }

  /**
   * Called by the router when the adapter reports a tab navigation / URL change.
   * If the new URL is controllable we just invalidate (the content script will
   * re-announce CONTENT_READY after the reload). If unsupported, we drop it
   * immediately.
   */
  onTabUpdated(tabId: number, changeInfo?: { status?: string; url?: string }): void {
    if (changeInfo?.url != null && isUnsupportedPageUrl(changeInfo.url)) {
      this.invalidate(tabId);
      return;
    }
    // Loading completion with a new URL means the content script will re-init.
    // Invalidate proactively so ensure() re-pings after the page is live.
    if (changeInfo?.status === "loading" || changeInfo?.url != null) {
      this.invalidate(tabId);
    }
  }
}
