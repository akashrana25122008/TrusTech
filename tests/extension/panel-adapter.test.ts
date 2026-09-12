import { describe, it, expect, afterEach } from "vitest";
import { PanelTransportAdapter } from "@/browser/panel";

let onMessageListener: ((...args: unknown[]) => unknown) | null = null;
let prevChrome: unknown;

function bootFakeRuntime() {
  prevChrome = (globalThis as any).chrome;
  const addListener = (listener: (...args: unknown[]) => unknown) => {
    onMessageListener = listener;
  };
  (globalThis as any).chrome = {
    runtime: {
      sendMessage: () => undefined,
      onMessage: { addListener },
    },
  };
}

afterEach(() => {
  onMessageListener = null;
  if (prevChrome === undefined) delete (globalThis as any).chrome;
  else (globalThis as any).chrome = prevChrome;
});

describe("Part 10 — panel event subscription", () => {
  it("registers one runtime listener and fans out broadcasts to every subscriber", () => {
    bootFakeRuntime();
    const adapter = new PanelTransportAdapter();
    const seen: unknown[][] = [[], []];
    adapter.onMessage((message) => void seen[0].push(message));
    adapter.onMessage((message) => void seen[1].push(message));

    const event = { type: "EVENT_TAB_CREATED", payload: { tabId: 42 } };
    onMessageListener?.(event, {}, () => undefined);

    expect(seen[0]).toEqual([event]);
    expect(seen[1]).toEqual([event]);
  });

  it("is inert (not ready) when no extension API exists", () => {
    const adapter = new PanelTransportAdapter();
    expect(adapter.ready).toBe(false);
  });
});

describe("Panel browser transport (panel → background RPC)", () => {
  let sent: unknown[];
  let replies: unknown[];

  function bootRpc() {
    prevChrome = (globalThis as any).chrome;
    sent = [];
    replies = [];
    (globalThis as any).chrome = {
      runtime: {
        lastError: undefined,
        sendMessage: (payload: unknown, cb: (res: unknown) => void) => {
          sent.push(payload);
          cb(replies.length > 0 ? replies.shift() : { ok: true });
        },
        onMessage: { addListener: () => undefined },
      },
    };
  }

  it("navigateTab sends BROWSER_COMMAND navigate with the target tab and resolves on background ok", async () => {
    bootRpc();
    replies.push({ ok: true });
    const adapter = new PanelTransportAdapter();
    await adapter.navigateTab(7, "https://www.youtube.com");
    expect(sent).toEqual([
      { type: "BROWSER_COMMAND", payload: { command: "navigate", tabId: 7, url: "https://www.youtube.com" } },
    ]);
  });

  it("navigateTab rejects (never false-succeeds) when the background reports failure", async () => {
    bootRpc();
    replies.push({ ok: false, error: "no_active_tab" });
    const adapter = new PanelTransportAdapter();
    await expect(adapter.navigateTab(7, "https://www.youtube.com")).rejects.toThrow(
      "navigate_failed: no_active_tab",
    );
  });

  it("activateTab routes switchTab with the tab id and reload/close navigate their commands", async () => {
    bootRpc();
    replies.push({ ok: true }, { ok: true }, { ok: true });
    const adapter = new PanelTransportAdapter();
    await adapter.activateTab(9);
    await adapter.reloadTab(9);
    await adapter.closeTab(9);
    expect(sent).toEqual([
      { type: "BROWSER_COMMAND", payload: { command: "switchTab", tabId: 9 } },
      { type: "BROWSER_COMMAND", payload: { command: "reload", tabId: 9 } },
      { type: "BROWSER_COMMAND", payload: { command: "closeTab", tabId: 9 } },
    ]);
  });

  it("goBackTab/goForwardTab return the real background verdict (no fire-and-forget true)", async () => {
    bootRpc();
    replies.push({ ok: true }, { ok: false, error: "content_script_not_ready" });
    const adapter = new PanelTransportAdapter();
    expect(await adapter.goBackTab(7)).toBe(true);
    expect(await adapter.goForwardTab(7)).toBe(false);
    expect(sent).toEqual([
      { type: "BROWSER_COMMAND", payload: { command: "back", tabId: 7 } },
      { type: "BROWSER_COMMAND", payload: { command: "forward", tabId: 7 } },
    ]);
  });
});