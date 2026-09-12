/* ------------------------------------------------------------------ *
 * MessageRouter v3 — async request relay between panel and content
 * scripts, plus page-change signals and legacy agent injection.
 *
 * v3 changes over v2:
 *   • CTX_* content RPC now flows through the ContentChannel:
 *       – URL is validated (chrome:// → unsupported_page error, no send).
 *       – ContentChannel.ensure() pings / injects if the script is cold.
 *       – Only reaches sendToTabAndRespond when confirmed reachable.
 *   • CONTENT_READY messages from the content script mark a tab ready.
 *   • INJECT_CONTENT_SCRIPT from the panel triggers on-demand injection.
 *   • AGENT_BROADCAST_TYPES are guarded by URL validation too.
 * ------------------------------------------------------------------ */

import type { TabService } from "./tabs";
import type { TabManager } from "./tab-manager";
import type { NavigationManager } from "./navigation-manager";
import type { WindowManager } from "./window-manager";
import type { ContentChannel } from "./content-channel";
import type { BrowserAdapter } from "@/browser";
import type { ContentReadyMessage, ContentErrorCode } from "@/shared/messages";

const PAGE_RELAY_TYPES: ReadonlySet<string> = new Set(["PAGE_CHANGED"]);
const CONTENT_RPC_TYPES: ReadonlySet<string> = new Set([
  "CTX_PING",
  "CTX_OBSERVE",
  "CTX_GROUND",
  "CTX_EXECUTE",
]);
const AGENT_BROADCAST_TYPES: ReadonlySet<string> = new Set([
  "AGENT_HIGHLIGHT",
  "AGENT_BEAM",
  "AGENT_INJECT_ACTION",
  "AGENT_STATE",
]);
const PANEL_EVENT_TYPES: ReadonlySet<string> = new Set([
  "EVENT_PAGE_CHANGED",
]);
const CONTENT_HANDSHAKE_TYPES: ReadonlySet<string> = new Set(["CONTENT_READY"]);

export class MessageRouter {
  constructor(
    private readonly tabs: TabService,
    private readonly tabMgr: TabManager,
    private readonly nav: NavigationManager,
    private readonly win: WindowManager,
    private readonly adapter: BrowserAdapter,
    private readonly content: ContentChannel,
  ) {}

  /**
   * Handle an incoming message.
   * Returns `true` if the message was claimed and, if supplied, a
   * promise for the eventual reply (when the message is a panel
   * request for content-relay or tab-command).
   */
  async handle(
    message: unknown,
    _sender: unknown,
    sendResponse: (reply: unknown) => void,
    sendPanelEvent: (event: unknown) => void,
  ): Promise<boolean> {
    const msg = message as Record<string, unknown> | undefined;
    if (!msg?.type || typeof msg.type !== "string") return false;
    const type = msg.type as string;

    // --- content handshake: CONTENT_READY push from the content script ---
    if (CONTENT_HANDSHAKE_TYPES.has(type)) {
      const sender = _sender as { tab?: { id?: number } } | undefined;
      const tabId = sender?.tab?.id;
      if (tabId != null) {
        this.content.markReady(tabId);
        const readyMsg = msg as unknown as ContentReadyMessage;
        sendPanelEvent({ type: "EVENT_CONTENT_READY", payload: { tabId, url: readyMsg?.payload?.url } });
      }
      sendResponse({ ok: true });
      return true;
    }

    // --- content-script relay (panel → SW → content) ---
    if (CONTENT_RPC_TYPES.has(type)) {
      const active = await this.tabMgr.active();
      if (!active) {
        sendResponse({ type: `${type}_RESULT`, payload: { error: "no_active_tab" } satisfies { error: ContentErrorCode } });
        return true;
      }

      // Ensure a content script is reachable (URL check + ping + inject).
      const ensure = await this.content.ensure(active.tabId);
      if (!ensure.ok) {
        const code: ContentErrorCode = ensure.code ?? "content_script_not_ready";
        sendResponse({ type: `${type}_RESULT`, payload: { error: code, message: ensure.message ?? undefined } satisfies { error: ContentErrorCode; message?: string } });
        return true;
      }

      try {
        const reply = await this.adapter.sendToTabAndRespond(active.tabId, message);
        // Stamp the origin tab: the content script cannot know its own tab id,
        // so the relay — which does — marks every snapshot with its source.
        // The controller refuses observations from the wrong tab.
        sendResponse(stampReplyTab(reply, active.tabId));
      } catch {
        sendResponse({ type: `${type}_RESULT`, payload: { error: "content_script_not_ready" } satisfies { error: ContentErrorCode } });
      }
      return true;
    }

    // --- content scripts pushing page change events ---
    if (PAGE_RELAY_TYPES.has(type)) {
      const sender = _sender as { tab?: { id?: number } } | undefined;
      const tabId = sender?.tab?.id;
      if (tabId != null) {
        const context = this.tabMgr.byId(tabId);
        if (context?.purpose) {
          this.tabMgr.registerPurpose(tabId, context.purpose);
        }
      }
      sendPanelEvent({ type: "EVENT_PAGE_CHANGED", payload: msg.payload });
      return true;
    }

    // --- agent commands relayed from the panel (legacy broadcast) ---
    if (AGENT_BROADCAST_TYPES.has(type)) {
      // URL guard: don't relay onto unsupported pages.
      const active = await this.tabMgr.active();
      if (active) {
        const ensure = await this.content.ensure(active.tabId);
        if (!ensure.ok) {
          sendResponse({ ok: false, error: ensure.code });
          return true;
        }
      }
      void this.tabs.broadcastToActiveTab(message as Record<string, unknown>);
      sendResponse({ ok: true });
      return true;
    }

    // --- panel events are ignored here (handled upstream) ---
    if (PANEL_EVENT_TYPES.has(type)) {
      return false;
    }

    // --- panel asks which tab is the agent's live context ---
    if (type === "QUERY_ACTIVE_TAB") {
      const active = await this.tabMgr.active();
      sendResponse(active ? { id: active.tabId, url: active.url, title: undefined } : null);
      return true;
    }

    // --- panel enumerates tabs / reads one tab ---
    if (type === "LIST_TABS") {
      const tabs = await this.adapter.listTabs();
      sendResponse(Array.isArray(tabs) ? tabs : []);
      return true;
    }
    if (type === "GET_TAB") {
      const { tabId } = (msg.payload ?? {}) as { tabId?: number };
      const tab = tabId == null ? await this.adapter.queryActiveTab() : await this.adapter.getTab(tabId);
      sendResponse(tab);
      return true;
    }

    // --- panel asks to inject content script on a specific tab ---
    if (type === "INJECT_CONTENT_SCRIPT") {
      const { tabId } = (msg.payload ?? {}) as { tabId?: number };
      if (tabId == null) {
        sendResponse({ ok: false, error: "missing_tabId" });
        return true;
      }
      const ok = await this.adapter.injectContentScript(tabId);
      if (ok) this.content.markReady(tabId);
      sendResponse({ ok });
      return true;
    }

    // --- tab/browser commands ---
    if (type === "BROWSER_COMMAND") {
      const cmdPayload = (msg.payload ?? {}) as { command?: string; url?: string; tabId?: number };
      const { command, url } = cmdPayload;
      const requestedTabId = typeof cmdPayload.tabId === "number" ? cmdPayload.tabId : undefined;
      const active = await this.tabMgr.active();
      let responded = false;
      const reply = (response: unknown): void => {
        if (responded) return;
        responded = true;
        sendResponse(response);
      };
      // Explicit tabId wins when the caller names a tab (the panel always
      // does); otherwise fall back to the active tab. A named tab is checked
      // against the browser API so stale ids fail honestly.
      const resolveTargetTabId = async (): Promise<number | null> => {
        if (requestedTabId != null) {
          const actual = await this.adapter.getTab(requestedTabId).catch(() => null);
          return actual ? requestedTabId : null;
        }
        return active?.tabId ?? null;
      };
      const missingTargetError = (): string => (requestedTabId != null ? "no_such_tab" : "no_active_tab");
      try {
        switch (command) {
        case "newTab": {
          const tab = await this.win.openTab(url);
          if (tab) {
            this.tabMgr.registerPurpose(tab.id, "new_tab");
            sendPanelEvent({ type: "EVENT_TAB_CREATED", payload: { tabId: tab.id, purpose: "new_tab" } });
          }
          reply({ ok: true, tabId: tab?.id });
          break;
        }
        case "newWindow": {
          const tab = await this.win.openWindow(url);
          if (tab) {
            this.tabMgr.registerPurpose(tab.id, "new_tab");
            sendPanelEvent({ type: "EVENT_TAB_CREATED", payload: { tabId: tab.id, purpose: "new_tab" } });
          }
          reply({ ok: true, tabId: tab?.id });
          break;
        }
        case "closeTab": {
          const targetId = await resolveTargetTabId();
          if (targetId == null) {
            reply({ ok: false, error: missingTargetError() });
            break;
          }
          this.tabMgr.registerPurpose(targetId, "closed");
          this.content.invalidate(targetId);
          await this.win.close(targetId);
          sendPanelEvent({ type: "EVENT_TAB_CLOSED", payload: { tabId: targetId } });
          reply({ ok: true });
          break;
        }
        case "switchTab": {
          const tabId = requestedTabId;
          if (tabId != null) {
            const actual = await this.adapter.getTab(tabId).catch(() => null);
            if (!actual) {
              reply({ ok: false, error: "no_such_tab" });
              break;
            }
            await this.win.activate(tabId);
            sendPanelEvent({ type: "EVENT_TAB_SWITCHED", payload: { tabId } });
          }
          reply({ ok: true });
          break;
        }
        case "reload": {
          const targetId = await resolveTargetTabId();
          if (targetId == null) {
            reply({ ok: false, error: missingTargetError() });
            break;
          }
          this.content.invalidate(targetId);
          reply(await this.nav.reload(targetId));
          break;
        }
        case "back": {
          const targetId = await resolveTargetTabId();
          if (targetId == null) {
            reply({ ok: false, error: missingTargetError() });
            break;
          }
          this.content.invalidate(targetId);
          reply(await this.nav.back(targetId));
          break;
        }
        case "forward": {
          const targetId = await resolveTargetTabId();
          if (targetId == null) {
            reply({ ok: false, error: missingTargetError() });
            break;
          }
          this.content.invalidate(targetId);
          reply(await this.nav.forward(targetId));
          break;
        }
        case "navigate": {
          const targetId = await resolveTargetTabId();
          if (targetId == null) {
            reply({ ok: false, error: missingTargetError() });
            break;
          }
          if (!url) {
            reply({ ok: false, error: "missing_url" });
            break;
          }
          this.content.invalidate(targetId);
          reply(await this.nav.navigate(targetId, url));
          break;
        }
        default:
          reply({ ok: false, error: `unknown_command: ${command}` });
        }
      } catch (e) {
        reply({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
      return true;
    }

    // Unclaimed message: still answer the caller so its response promise is
    // never left open (the channel is kept alive by the platform adapter for
    // async replies). This closes the old never-resolve-handshake hang.
    try {
      sendResponse({ ok: false, error: "unhandled_message" });
    } catch {
      /* channel already closed */
    }
    return false;
  }
}

/**
 * Stamp a relayed content reply with its origin tab. Only object payloads
 * are marked; error envelopes and unrecognized shapes pass through
 * untouched so existing contracts never change shape unexpectedly.
 */
function stampReplyTab(reply: unknown, tabId: number): unknown {
  if (reply && typeof reply === "object" && !Array.isArray(reply)) {
    const payload = (reply as { payload?: unknown }).payload;
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      return { ...(reply as Record<string, unknown>), payload: { ...(payload as Record<string, unknown>), tabId } };
    }
  }
  return reply;
}
