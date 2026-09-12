/**
 * §39 content-script lifecycle at unit level (real logic, fake transport):
 * ensure() classification, ping → inject → re-ping bounded retry, tab
 * invalidation, and the background relay path panel → tab → panel.
 */
import { describe, it, expect, vi } from "vitest";
import { ContentChannel } from "@/background/content-channel";
import { MessageRouter } from "@/background/router";
import { TabManager } from "@/background/tab-manager";
import { TabService } from "@/background/tabs";
import { NavigationManager } from "@/background/navigation-manager";
import { WindowManager } from "@/background/window-manager";
import type { BrowserAdapter } from "@/browser";

function adapter(over: Partial<Record<string, unknown>> = {}): BrowserAdapter {
  return {
    runtimeName: "chrome",
    queryActiveTab: async () => ({ id: 7, url: "https://example.com/", title: "t" }),
    getTab: async (id: number) => ({ id, url: "https://example.com/", title: "t" }),
    sendToTabAndRespond: async () => ({ type: "CTX_PONG" }),
    injectContentScript: async () => true,
    listTabs: async () => [],
    onTabActivated: () => {},
    onTabUpdated: () => {},
    onTabRemoved: () => {},
    ...over,
  } as unknown as BrowserAdapter;
}

describe("ContentChannel.ensure", () => {
  it("rejects browser-internal pages without touching the tab", async () => {
    const send = vi.fn();
    const ch = new ContentChannel(adapter({
      getTab: async (id: number) => ({ id, url: "chrome://newtab/", title: "" }),
      sendToTabAndRespond: send,
    }));
    const r = await ch.ensure(7);
    expect(r.ok).toBe(false);
    expect(r.code).toBe("unsupported_page");
    expect(send).not.toHaveBeenCalled();
  });

  it("accepts an already-ready tab without pinging", async () => {
    const send = vi.fn();
    const ch = new ContentChannel(adapter({ sendToTabAndRespond: send }));
    ch.markReady(7);
    expect((await ch.ensure(7)).ok).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  it("pings a cold tab and marks it ready on CTX_PONG", async () => {
    const ch = new ContentChannel(adapter({}));
    expect((await ch.ensure(7)).ok).toBe(true);
    expect(ch.isReady(7)).toBe(true);
  });

  it("bounded retry: failed ping → inject → re-ping success", async () => {
    let pings = 0;
    const injected: number[] = [];
    const ch = new ContentChannel(adapter({
      sendToTabAndRespond: async () => (++pings === 1 ? { type: "NOPE" } : { type: "CTX_PONG" }),
      injectContentScript: async (tabId: number) => { injected.push(tabId); return true; },
    }));
    expect((await ch.ensure(7)).ok).toBe(true);
    expect(injected).toEqual([7]);
    expect(pings).toBe(2);
  });

  it("gives up honestly when injection and ping both fail", async () => {
    const ch = new ContentChannel(adapter({
      sendToTabAndRespond: async () => { throw new Error("no receiving end"); },
      injectContentScript: async () => false,
    }));
    const r = await ch.ensure(7);
    expect(r.ok).toBe(false);
    expect(r.code).toBe("content_script_not_ready");
  });

  it("navigation loading state invalidates readiness (stale bridge dropped)", async () => {
    const ch = new ContentChannel(adapter({}));
    ch.markReady(7);
    ch.onTabUpdated(7, { status: "loading", url: "https://example.com/next" });
    expect(ch.isReady(7)).toBe(false);
  });
});

function routerWith(a: BrowserAdapter) {
  const tabs = new TabService(a);
  const tabMgr = new TabManager(a);
  const nav = new NavigationManager(a);
  const win = new WindowManager(a);
  const content = new ContentChannel(a);
  return new MessageRouter(tabs, tabMgr, nav, win, a, content);
}

describe("MessageRouter content relay (panel → tab → panel)", () => {
  it("relays CTX_OBSERVE to the active tab and stamps the origin tab id", async () => {
    const sent: Array<{ tabId: number; type: string }> = [];
    const a = adapter({
      sendToTabAndRespond: async (tabId: number, msg: unknown) => {
        const type = (msg as { type: string }).type;
        sent.push({ tabId, type });
        if (type === "CTX_PING") return { type: "CTX_PONG" };
        return { type: "CTX_OBSERVE_RESULT", payload: { url: "https://example.com/", visibleText: "hi", elements: [] } };
      },
    });
    const router = routerWith(a);
    const replies: unknown[] = [];
    const events: unknown[] = [];
    const claimed = await router.handle(
      { type: "CTX_OBSERVE" },
      {},
      (r) => replies.push(r),
      (e) => events.push(e),
    );
    expect(claimed).toBe(true);
    expect(sent).toContainEqual({ tabId: 7, type: "CTX_OBSERVE" });
    const payload = (replies[0] as { payload: Record<string, unknown> }).payload;
    expect(payload.tabId).toBe(7);
    expect(payload.visibleText).toBe("hi");
  });

  it("never sends page RPC onto an unsupported page (error envelope instead)", async () => {
    const send = vi.fn();
    const a = adapter({
      queryActiveTab: async () => ({ id: 7, url: "chrome://newtab/", title: "" }),
      getTab: async (id: number) => ({ id, url: "chrome://newtab/", title: "" }),
      sendToTabAndRespond: send,
    });
    const router = routerWith(a);
    const replies: unknown[] = [];
    await router.handle({ type: "CTX_OBSERVE" }, {}, (r) => replies.push(r), () => {});
    expect(send).not.toHaveBeenCalled();
    expect((replies[0] as { payload: { error: string } }).payload.error).toBe("unsupported_page");
  });

  it("CONTENT_READY marks the tab and notifies panels", async () => {
    const a = adapter({});
    const router = routerWith(a);
    const replies: unknown[] = [];
    const events: unknown[] = [];
    await router.handle(
      { type: "CONTENT_READY", payload: { kind: "load", url: "https://example.com/" } },
      { tab: { id: 9 } },
      (r) => replies.push(r),
      (e) => events.push(e),
    );
    expect(replies).toEqual([{ ok: true }]);
    expect(events).toEqual([{ type: "EVENT_CONTENT_READY", payload: { tabId: 9, url: "https://example.com/" } }]);
  });
});
