import { describe, it, expect, vi } from "vitest";
import { MessageRouter } from "@/background/router";
import { ContentChannel } from "@/background/content-channel";
import { TabService } from "@/background/tabs";
import { TabManager } from "@/background/tab-manager";
import { NavigationManager } from "@/background/navigation-manager";
import { WindowManager } from "@/background/window-manager";
import type { BrowserAdapter } from "@/browser";

/** Minimal adapter stub — enough to verify routing without a browser. */
function stubAdapter(overrides: Partial<BrowserAdapter> = {}): BrowserAdapter {
  return {
    runtimeName: "chrome",
    queryActiveTab: async () => ({ id: 7, url: "https://example.com", title: "Example" }),
    listTabs: async () => [{ id: 7, url: "https://example.com", title: "Example" }],
    sendToTab: async () => undefined,
    sendToTabEnsured: async () => undefined,
    sendToTabAndRespond: async (_tabId: number, message: unknown) => {
      const msg = message as { type?: string };
      if (msg?.type === "CTX_PING") return { type: "CTX_PONG", payload: { ok: true, url: "https://example.com" } };
      return { type: "CTX_OBSERVE_RESULT", payload: { url: "https://example.com" } };
    },
    createTab: async () => null,
    activateTab: async () => undefined,
    closeTab: async () => undefined,
    closeActiveTab: async () => undefined,
    reloadTab: async () => undefined,
    reloadActiveTab: async () => undefined,
    navigateTab: async () => undefined,
    goBackTab: async () => true,
    goForwardTab: async () => true,
    createWindow: async () => null,
    getTab: async () => ({ id: 7, url: "https://example.com", title: "Example" }),
    injectContentScript: async () => true,
    setOpenPanelOnActionClick: () => undefined,
    openPanel: async () => undefined,
    onActionClicked: () => undefined,
    onInstalled: () => undefined,
    onStartup: () => undefined,
    onMessage: () => undefined,
    onTabActivated: () => undefined,
    onTabUpdated: () => undefined,
    onTabRemoved: () => undefined,
    ...overrides,
  } as BrowserAdapter;
}

/** Build the router over a TabManager that already knows the active tab. */
async function routerFor(adapter: BrowserAdapter): Promise<MessageRouter> {
  const tabMgr = new TabManager(adapter);
  await tabMgr.refresh();
  return new MessageRouter(
    new TabService(adapter),
    tabMgr,
    new NavigationManager(adapter),
    new WindowManager(adapter),
    adapter,
    new ContentChannel(adapter),
  );
}

function noop() {}
function noopEvent() {}

describe("MessageRouter", () => {
  it("relays CTX_OBSERVE to the active tab's content script", async () => {
    const adapter = stubAdapter();
    const respond = vi.fn();
    const router = await routerFor(adapter);
    await router.handle({ type: "CTX_OBSERVE" }, {}, respond, noopEvent);
    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond.mock.calls[0][0]).toMatchObject({ type: "CTX_OBSERVE_RESULT" });
  });

  it("relays CTX_PING to the active tab and answers CTX_PONG (handshake)", async () => {
    const adapter = stubAdapter();
    const respond = vi.fn();
    const router = await routerFor(adapter);
    await router.handle({ type: "CTX_PING" }, {}, respond, noopEvent);
    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond.mock.calls[0][0]).toMatchObject({
      type: "CTX_PONG",
      payload: { ok: true },
    });
  });

  it("broadcasts agent messages to the active tab", async () => {
    const adapter = stubAdapter();
    const broadcast = vi.fn(async () => undefined);
    adapter.sendToTabEnsured = broadcast;
    const router = await routerFor(adapter);
    await router.handle({ type: "AGENT_BEAM", payload: { on: true, selector: "body" } }, {}, noop, noopEvent);
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it("relays PAGE_CHANGED to the panel event stream", async () => {
    const adapter = stubAdapter();
    const eventRelay = vi.fn();
    const router = await routerFor(adapter);
    await router.handle({ type: "PAGE_CHANGED", payload: { kind: "mutation" } }, { tab: { id: 99 } }, noop, eventRelay);
    expect(eventRelay).toHaveBeenCalledTimes(1);
    expect(eventRelay.mock.calls[0][0]).toMatchObject({ type: "EVENT_PAGE_CHANGED" });
  });

  it("ignores unknown message types but still answers the caller", async () => {
    const adapter = stubAdapter();
    const respond = vi.fn();
    const router = await routerFor(adapter);
    // handle() reports "not claimed"...
    expect(await router.handle({ type: "SOMETHING_ELSE" }, {}, respond, noopEvent)).toBe(false);
    // ...yet the caller is answered so its response promise never hangs.
    expect(respond).toHaveBeenCalledWith({ ok: false, error: "unhandled_message" });
  });

  it("marks a tab ready and relays the event when CONTENT_READY arrives", async () => {
    const adapter = stubAdapter();
    const eventRelay = vi.fn();
    const respond = vi.fn();
    const router = await routerFor(adapter);
    await router.handle(
      { type: "CONTENT_READY", payload: { kind: "load", url: "https://example.com" } },
      { tab: { id: 7 } },
      respond,
      eventRelay,
    );
    expect(respond).toHaveBeenCalledWith({ ok: true });
    expect(eventRelay.mock.calls[0][0]).toMatchObject({ type: "EVENT_CONTENT_READY", payload: { tabId: 7 } });
  });

  it("does not message an unsupported page and returns a typed error", async () => {
    const adapter = stubAdapter({
      getTab: async () => ({ id: 7, url: "chrome://extensions/" }),
    });
    const sendRpc = vi.fn(async () => ({ type: "CTX_OBSERVE_RESULT" }));
    adapter.sendToTabAndRespond = sendRpc;
    const respond = vi.fn();
    const router = await routerFor(adapter);
    await router.handle({ type: "CTX_OBSERVE" }, {}, respond, noopEvent);
    expect(sendRpc).not.toHaveBeenCalled();
    expect(respond.mock.calls[0][0]).toMatchObject({
      type: "CTX_OBSERVE_RESULT",
      payload: { error: "unsupported_page" },
    });
  });

  it("rejects a content RPC when no tab is active", async () => {
    const adapter = stubAdapter({
      queryActiveTab: async () => null,
      listTabs: async () => [],
    });
    const sendRpc = vi.fn(async () => ({ type: "CTX_OBSERVE_RESULT" }));
    adapter.sendToTabAndRespond = sendRpc;
    const respond = vi.fn();
    const router = await routerFor(adapter);
    await router.handle({ type: "CTX_OBSERVE" }, {}, respond, noopEvent);
    expect(sendRpc).not.toHaveBeenCalled();
    expect(respond.mock.calls[0][0]).toMatchObject({
      type: "CTX_OBSERVE_RESULT",
      payload: { error: "no_active_tab" },
    });
  });

  it("stamps relayed content replies with the origin tab id", async () => {
    const adapter = stubAdapter();
    const respond = vi.fn();
    const router = await routerFor(adapter);
    await router.handle({ type: "CTX_OBSERVE" }, {}, respond, noopEvent);
    expect(respond.mock.calls[0][0]).toMatchObject({
      type: "CTX_OBSERVE_RESULT",
      payload: { url: "https://example.com", tabId: 7 },
    });
  });

  it("reports an honest failure for back/forward when the content bridge is down", async () => {
    const adapter = stubAdapter({
      goBackTab: async () => false,
      goForwardTab: async () => false,
    });
    const router = await routerFor(adapter);

    for (const command of ["back", "forward"]) {
      const respond = vi.fn();
      await router.handle(
        { type: "BROWSER_COMMAND", payload: { command } },
        {},
        respond,
        noopEvent,
      );
      expect(respond).toHaveBeenCalledWith({ ok: false, error: "content_script_not_ready" });
    }
  });

  it("switches tabs by activating, never by navigating (no bogus navigate)", async () => {
    const adapter = stubAdapter({
      getTab: async () => ({ id: 9, url: "https://example.com/other", title: null as unknown as string }),
    });
    const navigate = vi.fn(async () => undefined);
    const activate = vi.fn(async () => undefined);
    adapter.navigateTab = navigate;
    adapter.activateTab = activate;
    const respond = vi.fn();
    const router = await routerFor(adapter);
    await router.handle(
      { type: "BROWSER_COMMAND", payload: { command: "switchTab", tabId: 9 } },
      {},
      respond,
      noopEvent,
    );
    expect(activate).toHaveBeenCalledWith(9);
    expect(navigate).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith({ ok: true });
  });

  it("answers LIST_TABS and GET_TAB with tab info", async () => {
    const adapter = stubAdapter();
    const router = await routerFor(adapter);

    const respondList = vi.fn();
    await router.handle({ type: "LIST_TABS" }, {}, respondList, noopEvent);
    expect(respondList).toHaveBeenCalledWith([
      { id: 7, url: "https://example.com", title: "Example" },
    ]);

    const respondGet = vi.fn();
    await router.handle({ type: "GET_TAB", payload: { tabId: 7 } }, {}, respondGet, noopEvent);
    expect(respondGet).toHaveBeenCalledWith({ id: 7, url: "https://example.com", title: "Example" });
  });

  it("opens a new window and reports the created tab", async () => {
    const adapter = stubAdapter({
      createWindow: async () => ({ id: 42, url: "about:newtab", title: null as unknown as string }),
    });
    const respond = vi.fn();
    const router = await routerFor(adapter);
    await router.handle(
      { type: "BROWSER_COMMAND", payload: { command: "newWindow", url: "https://example.com" } },
      {},
      respond,
      noopEvent,
    );
    expect(respond).toHaveBeenCalledWith({ ok: true, tabId: 42 });
  });

  it("routes an explicit-tabId navigate to that tab instead of only the active tab", async () => {
    const adapter = stubAdapter();
    const navigate = vi.fn(async () => undefined);
    adapter.navigateTab = navigate;
    const respond = vi.fn();
    const router = await routerFor(adapter);
    await router.handle(
      { type: "BROWSER_COMMAND", payload: { command: "navigate", tabId: 9, url: "https://example.com/9" } },
      {},
      respond,
      noopEvent,
    );
    expect(navigate).toHaveBeenCalledWith(9, "https://example.com/9");
    expect(respond).toHaveBeenCalledWith({ ok: true });
  });

  it("reports no_such_tab for an explicit tabId the browser no longer has", async () => {
    const adapter = stubAdapter({ getTab: async () => null });
    const respond = vi.fn();
    const router = await routerFor(adapter);
    await router.handle(
      { type: "BROWSER_COMMAND", payload: { command: "closeTab", tabId: 4242 } },
      {},
      respond,
      noopEvent,
    );
    expect(respond).toHaveBeenCalledWith({ ok: false, error: "no_such_tab" });
  });
});

describe("ContentChannel", () => {
  it("answers CTX_PING on a live tab without injecting", async () => {
    const adapter = stubAdapter();
    const inject = vi.fn(async () => true);
    adapter.injectContentScript = inject;
    const channel = new ContentChannel(adapter);
    const result = await channel.ensure(7);
    expect(result.ok).toBe(true);
    expect(inject).not.toHaveBeenCalled();
  });

  it("injects then re-pings when the content script is not loaded yet", async () => {
    let pings = 0;
    const adapter = stubAdapter({
      sendToTabAndRespond: async (_tabId: number, message: unknown) => {
        const msg = message as { type?: string };
        if (msg?.type === "CTX_PING") {
          pings++;
          // First ping fails (no script loaded yet), second succeeds.
          if (pings === 1) return undefined;
          return { type: "CTX_PONG", payload: { ok: true, url: "https://example.com" } };
        }
        return { type: "CTX_OBSERVE_RESULT" };
      },
      injectContentScript: async () => true,
    });
    const channel = new ContentChannel(adapter);
    const inject = vi.spyOn(adapter, "injectContentScript");
    const result = await channel.ensure(7);
    expect(result.ok).toBe(true);
    expect(inject).toHaveBeenCalledTimes(1);
    expect(pings).toBe(2);
  });

  it("returns unsupported_page for chrome:// URLs before pinging or injecting", async () => {
    const adapter = stubAdapter({
      getTab: async () => ({ id: 7, url: "chrome://extensions/" }),
      sendToTabAndRespond: async () => {
        throw new Error("must not be called");
      },
      injectContentScript: async () => true,
    });
    const channel = new ContentChannel(adapter);
    const result = await channel.ensure(7);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("unsupported_page");
  });

  it("invalidates readiness when a tab navigates to an unsupported page", async () => {
    const adapter = stubAdapter({ getTab: async () => ({ id: 7, url: "about:blank" }) });
    const channel = new ContentChannel(adapter);
    channel.markReady(7);
    expect(channel.isReady(7)).toBe(true);
    channel.onTabUpdated(7, { url: "chrome://extensions/" });
    expect(channel.isReady(7)).toBe(false);
    const result = await channel.ensure(7);
    expect(result.code).toBe("unsupported_page");
  });
});