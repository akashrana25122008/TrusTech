import { describe, it, expect, afterEach } from "vitest";
import { createFirefoxAdapter } from "@/browser/firefox";

let prevChrome: unknown;
let prevBrowser: unknown;

function bootMinimalApi() {
  prevChrome = (globalThis as any).chrome;
  prevBrowser = (globalThis as any).browser;
  // firefox.ts prefers `browser.sidebarAction`; base chrome adapter will
  // delegate to rawApi() — provide both contexts the adapter touches.
  (globalThis as any).chrome = {
    tabs: {
      query: (_opts: unknown, cb: (tabs: unknown[]) => void) => cb([]),
      sendMessage: (_id: number, _p: unknown, cb: () => void) => cb(),
    },
    runtime: { lastError: undefined, sendMessage: () => undefined, onMessage: undefined },
    action: {},
  };
  (globalThis as any).browser = {
    sidebarAction: {},
  };
}

afterEach(() => {
  if (prevBrowser === undefined) delete (globalThis as any).browser;
  else (globalThis as any).browser = prevBrowser;
  if (prevChrome === undefined) delete (globalThis as any).chrome;
  else (globalThis as any).chrome = prevChrome;
});

describe("Part 16 — Firefox adapter (native promise namespace)", () => {
  it("reports the firefox runtime and never throws when sidebarAction is absent", async () => {
    bootMinimalApi();
    const adapter = createFirefoxAdapter();
    expect(adapter.runtimeName).toBe("firefox");

    // No sidebarAction key on the stub → both panel methods must be no-ops.
    await expect(adapter.openPanel()).resolves.toBeUndefined();
    expect(() => adapter.setOpenPanelOnActionClick()).not.toThrow();

    // Basic delivery after the game — must not throw on a failed send.
    await expect(adapter.listTabs()).resolves.toEqual([]);
  });
});