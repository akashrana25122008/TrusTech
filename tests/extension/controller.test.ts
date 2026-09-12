import { describe, it, expect, vi } from "vitest";
import { AgentController } from "@/agent/controller";
import { AgentEventBus } from "@/shared/event-bus";
import { GatewayLlmProvider } from "@/llm/gateway-provider";
import { buildLlmPlanner } from "@/agent/llm-planner";
import type { BrowserAdapter } from "@/browser";
import type { ObservationSnapshot, ActionResult } from "@/shared/messages";

/**
 * A fake "page" the controller talks to as if it were a real browser.
 * Implements CTX_OBSERVE / CTX_EXECUTE and BROWSER_COMMAND navigate so
 * the closed loop runs end-to-end without a browser.
 */
function fakeWeb(failOn?: "type" | "press_key") {
  const state = {
    url: "https://example.com",
    visibleText: "Welcome",
    query: "",
    results: false,
  };

  const snapshot = (): ObservationSnapshot => ({
    url: state.url,
    title: "Example",
    tabId: 7,
    pageType: "search",
    viewport: { w: 1000, h: 800 },
    scrollY: 0,
    scrollH: 0,
    loading: false,
    visibleText: state.visibleText,
    elements: [
      { id: "el_001", role: "searchbox", name: "Search the web", tag: "input", visible: true, enabled: true, focused: false, type: "search", value: state.query, rect: { x: 0, y: 0, w: 50, h: 20 } },
      { id: "el_002", role: "button", name: "Search", tag: "button", visible: true, enabled: true, focused: false, rect: { x: 0, y: 0, w: 50, h: 20 } },
    ],
    counted: 2,
    createdAt: Date.now(),
  });

  const execute = (msg: { type: string; payload?: any }): ActionResult => {
    const payload = msg.payload ?? {};
    if (payload.command === "navigate") {
      state.url = payload.url;
      state.visibleText = `Landed on ${state.url}. ${state.visibleText}`;
      return { ok: true };
    }
    if (msg.type === "CTX_EXECUTE") {
      const act = payload.action as { action: string; text?: string; key?: string };
      if (failOn && act.action === failOn) {
        return { ok: false, error: "stale element removed on page" };
      }
      if (act.action === "type") {
        state.query += act.text ?? "";
        state.visibleText = `${state.visibleText} [typed: ${state.query}]`;
        return { ok: true, hint: { value: act.text } };
      }
      if (act.action === "press_key" && act.key === "Enter") {
        state.results = true;
        state.visibleText = `${state.visibleText} ${state.query} RESULTS: tutorial one, tutorial two`;
        return { ok: true };
      }
      if (act.action === "finish") return { ok: true, hint: {} };
      return { ok: false, error: `unhandled: ${act.action}` };
    }
    return { ok: false, error: "unhandled" };
  };

  const adapter = {
    runtimeName: "chrome",
    navigateTab: async (_tabId: number, url: string) => {
      state.url = url;
      state.visibleText = `Landed on ${url}. ${state.visibleText}`;
    },
    reloadTab: async () => undefined,
    closeTab: async () => undefined,
    createTab: async () => null,
    listTabs: async () => [],
    activateTab: async () => undefined,
    sendToTabAndRespond: async (_tabId: number, message: unknown): Promise<unknown> => {
      const msg = message as { type: string; payload?: any };
      if (msg.type === "CTX_PING") return { type: "CTX_PONG", payload: { ok: true, url: state.url } };
      if (msg.type === "CTX_OBSERVE") return { type: "CTX_OBSERVE_RESULT", payload: snapshot() };
      if (msg.type === "BROWSER_COMMAND") {
        const result = execute(msg as never);
        return result;
      }
      if (msg.type === "CTX_EXECUTE") {
        const result = execute(msg as never);
        return { type: "CTX_EXECUTE_RESULT", payload: result };
      }
      return { ok: false };
    },
  } as unknown as BrowserAdapter;

  return { adapter, state, snapshot };
}

describe("AgentController closed loop", () => {
  it("routes browser-level actions to the adapter — never BROWSER_COMMAND into the page", async () => {
    const { adapter } = fakeWeb();
    const sentTypes: string[] = [];
    const original = adapter.sendToTabAndRespond;
    adapter.sendToTabAndRespond = async (t: number, m: unknown) => {
      const type = (m as { type?: string })?.type;
      if (type) sentTypes.push(type);
      return original(t, m);
    };
    const bus = new AgentEventBus();
    const controller = new AgentController(adapter, bus);
    bus.on("USER_INPUT_REQUIRED", () => controller.confirm());
    await controller.run("search youtube tutorial", 7);

    // The content script must never receive a background command message…
    expect(sentTypes).not.toContain("BROWSER_COMMAND");
    // …navigation happened through the adapter instead…
    expect(sentTypes).toContain("CTX_PING");
    // …and page actions still travel as CTX_EXECUTE.
    expect(sentTypes).toContain("CTX_EXECUTE");
  });
  it("drives a search task to completion with verified steps", async () => {
    const { adapter, state } = fakeWeb();
    const bus = new AgentEventBus();
    const events: string[] = [];
    bus.on("ACTION_SUCCEEDED", ({ action }) => {
      events.push(action.action);
    });

    const controller = new AgentController(adapter, bus);
    const task = new Promise<void>((resolve) => {
      bus.on("TASK_COMPLETED", () => resolve());
    });
    // High-risk browser actions (navigate) need the user's OK — auto-approve.
    bus.on("USER_INPUT_REQUIRED", () => controller.confirm());

    await controller.run("search youtube tutorial", 7);
    await task;

    expect(state.query).toContain("youtube");
    expect(state.results).toBe(true);
    // navigate → type → press_key → finish
    expect(events).toEqual(["navigate", "type", "press_key", "finish"]);
    expect(controller.status.runtime).toBe("COMPLETED");
  });

  it("pauses and resumes without wrecking the loop", async () => {
    const { adapter } = fakeWeb();
    const bus = new AgentEventBus();
    const controller = new AgentController(adapter, bus);
    bus.on("USER_INPUT_REQUIRED", () => controller.confirm());

    const done = new Promise<void>((resolve) => bus.on("TASK_COMPLETED", () => resolve()));
    const runPromise = controller.run("search youtube tutorial", 7);
    setTimeout(() => controller.pause(), 10);
    setTimeout(() => controller.resume(), 30);

    await Promise.race([done, runPromise]);
    expect(controller.status.runtime).toBe("COMPLETED");
  });

  it("fails a task that the page cannot perform", async () => {
    const { adapter } = fakeWeb("type");
    const bus = new AgentEventBus();
    const events: string[] = [];
    bus.on("TASK_FAILED", ({ reason }) => {
      events.push(reason);
    });

    const controller = new AgentController(adapter, bus);
    bus.on("USER_INPUT_REQUIRED", () => controller.confirm());
    const fail = new Promise<void>((resolve) => bus.on("TASK_FAILED", () => resolve()));
    await controller.run("search youtube tutorial", 7);
    await fail;

    expect(events.length).toBeGreaterThan(0);
    expect(controller.status.runtime).toBe("FAILED");
  });

  it("fails gracefully when the tab becomes unsupported mid-task (no false OBSERVING/ACTIVE)", async () => {
    // Bridge answers the handshake ping, then the page turns into an
    // unsupported scheme (chrome:// etc.) between observation steps.
    const dead = fakeWeb();
    dead.adapter.sendToTabAndRespond = async (_tabId, message) => {
      const msg = message as { type: string };
      if (msg.type === "CTX_PING") return { type: "CTX_PONG", payload: { ok: true, url: "https://example.com" } };
      return { type: "CTX_OBSERVE_RESULT", payload: { error: "unsupported_page" } };
    };

    const bus = new AgentEventBus();
    const reasons: string[] = [];
    bus.on("TASK_FAILED", ({ reason }) => reasons.push(reason));

    const controller = new AgentController(dead.adapter, bus);
    const failed = new Promise<void>((resolve) => bus.on("TASK_FAILED", () => resolve()));
    await controller.run("search youtube tutorial", 7);
    await failed;

    expect(reasons[0]).toBe("Browser page cannot be controlled. Open a regular webpage to continue.");
    expect(controller.status.runtime).toBe("FAILED");
  });

  it("follows the user onto a new active tab mid-task (multi-tab state by tabId)", async () => {
    // Two live pages: the user starts on tab 7, then switches to tab 8
    // between loop iterations. The controller must drive tab 8's page.
    const stateA = { url: "https://example.com", visibleText: "Welcome to tab seven", query: "", results: false };
    const stateB = { url: "https://example.org", visibleText: "Welcome to tab eight", query: "", results: false };

    const snap = (state: typeof stateA, tabId: number): ObservationSnapshot => ({
      url: state.url,
      title: `Tab ${tabId}`,
      tabId,
      pageType: "search",
      viewport: { w: 1000, h: 800 },
      scrollY: 0,
      scrollH: 0,
      loading: false,
      visibleText: state.visibleText,
      elements: [
        { id: "el_001", role: "searchbox", name: "Search", tag: "input", visible: true, enabled: true, focused: false, type: "search", value: state.query, rect: { x: 0, y: 0, w: 50, h: 20 } },
        { id: "el_002", role: "button", name: "Go", tag: "button", visible: true, enabled: true, focused: false, rect: { x: 0, y: 0, w: 50, h: 20 } },
      ],
      counted: 2,
      createdAt: Date.now(),
    });

    let switches = 0; // count of queryActiveTab calls
    const responder = (state: typeof stateA, tabId: number) => (message: unknown): any => {
      const msg = message as { type: string; payload?: any };
      if (msg.type === "CTX_PING") return { type: "CTX_PONG", payload: { ok: true, url: state.url } };
      if (msg.type === "CTX_OBSERVE") return { type: "CTX_OBSERVE_RESULT", payload: snap(state, tabId) };
      if (msg.type === "CTX_EXECUTE") {
        const act = msg.payload?.action as { action: string; text?: string; key?: string };
        if (act.action === "type") {
          state.query += act.text ?? "";
          state.visibleText = `${state.visibleText} [typed: ${state.query}]`;
          return { type: "CTX_EXECUTE_RESULT", payload: { ok: true, hint: { value: act.text } } };
        }
        if (act.action === "press_key" && act.key === "Enter") {
          state.results = true;
          state.visibleText = `${state.visibleText} ${state.query} RESULTS: one, two`;
          return { type: "CTX_EXECUTE_RESULT", payload: { ok: true } };
        }
        if (act.action === "finish") return { type: "CTX_EXECUTE_RESULT", payload: { ok: true, hint: {} } };
        return { type: "CTX_EXECUTE_RESULT", payload: { ok: false, error: `unhandled: ${act.action}` } };
      }
      return { ok: false };
    };
    const replyA = responder(stateA, 7);
    const replyB = responder(stateB, 8);

    const adapter = {
      runtimeName: "chrome",
      queryActiveTab: async () => {
        switches++;
        // First resolution (handshake bootstrap) → tab 7; after that, tab 8.
        return switches <= 1 ? ({ id: 7, url: stateA.url, title: "Tab 7" } as any) : ({ id: 8, url: stateB.url, title: "Tab 8" } as any);
      },
      sendToTabAndRespond: async (tabId: number, message: unknown) => (tabId === 8 ? replyB : replyA)(message),
      navigateTab: async (_tabId: number, url: string) => {
        stateA.url = url;
        stateB.url = url;
      },
      reloadTab: async () => undefined,
      createTab: async () => null,
      activateTab: async () => undefined,
      listTabs: async () => [],
      closeTab: async () => undefined,
    } as unknown as BrowserAdapter;

    const bus = new AgentEventBus();
    const tabEvents: Array<{ tabId: number; previous: number }> = [];
    bus.on("TAB_CHANGED", (e) => tabEvents.push(e));
    const controller = new AgentController(adapter, bus);
    bus.on("USER_INPUT_REQUIRED", () => controller.confirm());
    const completed = new Promise<void>((resolve) => bus.on("TASK_COMPLETED", () => resolve()));

    await controller.run("search youtube tutorial", 7);
    await completed;

    // The controller observed tab 7 first, then switched to tab 8.
    expect(tabEvents).toEqual([{ tabId: 8, previous: 7 }]);
    // The search ran on tab 8's page — its state got the typed query.
    expect(stateB.results).toBe(true);
    // Tab 7's page was never driven.
    expect(stateA.results).toBe(false);
    expect(controller.status.runtime).toBe("COMPLETED");
  });

  it("uses the injected custom planner instead of the deterministic one", async () => {
    const { adapter } = fakeWeb();
    const bus = new AgentEventBus();
    const plannerCalls: string[] = [];
    // A custom planner that picks its own action per step.
    const customPlanner = () => {
      plannerCalls.push("custom");
      return { action: { action: "finish" as const, result: "custom path", confidence: 0.99 }, justification: "test-only" };
    };
    const controller = new AgentController(adapter, bus, customPlanner);
    bus.on("USER_INPUT_REQUIRED", () => controller.confirm());
    const completed = new Promise<void>((resolve) => bus.on("TASK_COMPLETED", () => resolve()));
    await controller.run("search youtube tutorial", 7);
    await completed;

    expect(plannerCalls.length).toBeGreaterThan(0);
    expect(controller.status.runtime).toBe("COMPLETED");
  });
});

/**
 * A fake browser starting on chrome://newtab/: no DOM bridge exists, but
 * browser-level navigation works and the destination page goes live
 * (after two transient cold observations, exercising the post-navigation
 * content-ready wait).
 */
function fakeNewtabWeb() {
  const state = {
    url: "chrome://newtab/",
    live: false,
    coldObserves: 0,
    query: "",
    results: false,
    navigations: [] as string[],
  };

  const liveSnapshot = (): ObservationSnapshot => ({
    url: state.url,
    title: "Example",
    tabId: 7,
    pageType: "search",
    viewport: { w: 1000, h: 800 },
    scrollY: 0,
    scrollH: 0,
    loading: false,
    visibleText: state.results ? `Results for ${state.query}: one, two` : `Welcome ${state.query}`,
    elements: [
      { id: "el_001", role: "searchbox", name: "Search", tag: "input", visible: true, enabled: true, focused: false, type: "search", value: state.query, rect: { x: 0, y: 0, w: 50, h: 20 } },
      { id: "el_002", role: "button", name: "Go", tag: "button", visible: true, enabled: true, focused: false, rect: { x: 0, y: 0, w: 50, h: 20 } },
    ],
    counted: 2,
    createdAt: Date.now(),
  });

  const adapter = {
    runtimeName: "chrome",
    queryActiveTab: async () => ({ id: 7, url: state.url, title: "Tab" }),
    navigateTab: async (_tabId: number, url: string) => {
      state.navigations.push(url);
      state.url = url;
      state.live = true;
      state.coldObserves = 2;
    },
    reloadTab: async () => undefined,
    closeTab: async () => undefined,
    createTab: async () => null,
    listTabs: async () => [],
    activateTab: async () => undefined,
    goBackTab: async () => true,
    goForwardTab: async () => true,
    sendToTabAndRespond: async (_tabId: number, message: unknown): Promise<unknown> => {
      const msg = message as { type: string; payload?: any };
      if (!state.live) {
        if (msg.type === "CTX_PING") return { type: "CTX_PING_RESULT", payload: { error: "unsupported_page" } };
        return { type: "CTX_OBSERVE_RESULT", payload: { error: "unsupported_page" } };
      }
      if (msg.type === "CTX_PING") return { type: "CTX_PONG", payload: { ok: true, url: state.url } };
      if (msg.type === "CTX_OBSERVE") {
        if (state.coldObserves > 0) {
          state.coldObserves--;
          return { type: "CTX_OBSERVE_RESULT", payload: { error: "content_script_not_ready" } };
        }
        return { type: "CTX_OBSERVE_RESULT", payload: liveSnapshot() };
      }
      if (msg.type === "CTX_EXECUTE") {
        const act = msg.payload?.action as { action: string; text?: string; key?: string };
        if (act.action === "type") {
          state.query += act.text ?? "";
          return { type: "CTX_EXECUTE_RESULT", payload: { ok: true, hint: { value: act.text } } };
        }
        if (act.action === "press_key" && act.key === "Enter") {
          state.results = true;
          return { type: "CTX_EXECUTE_RESULT", payload: { ok: true } };
        }
        if (act.action === "finish") return { type: "CTX_EXECUTE_RESULT", payload: { ok: true, hint: {} } };
        return { type: "CTX_EXECUTE_RESULT", payload: { ok: false, error: `unhandled: ${act.action}` } };
      }
      return { ok: false };
    },
  } as unknown as BrowserAdapter;

  return { adapter, state };
}

describe("AgentController on browser-internal pages", () => {  it("CASE 1/2/5: navigates away from chrome://newtab/ and completes the task", async () => {
    const { adapter, state } = fakeNewtabWeb();
    const bus = new AgentEventBus();
    const notices: string[] = [];
    bus.on("PAGE_NOT_CONTROLLABLE", ({ url }) => notices.push(url));
    const controller = new AgentController(adapter, bus);
    bus.on("USER_INPUT_REQUIRED", () => controller.confirm());
    const completed = new Promise<void>((resolve) => bus.on("TASK_COMPLETED", () => resolve()));

    await controller.run("search youtube tutorial", 7);
    await completed;

    // Browser-level navigate executed despite the scriptless start page…
    expect(state.navigations).toHaveLength(1);
    expect(state.navigations[0]).toContain("google.com");
    // …the UI was told page controls were unavailable (not a terminal error)…
    expect(notices).toEqual(["chrome://newtab/"]);
    // …and page control began after navigation: typed + submitted + done.
    expect(state.query).toContain("youtube");
    expect(state.results).toBe(true);
    expect(controller.status.runtime).toBe("COMPLETED");
  });

  it("CASE 4: a task needing the current internal page fails honestly (no vacuous finish)", async () => {
    const { adapter, state } = fakeNewtabWeb();
    const bus = new AgentEventBus();
    const reasons: string[] = [];
    bus.on("TASK_FAILED", ({ reason }) => reasons.push(reason));
    const controller = new AgentController(adapter, bus);
    const failed = new Promise<void>((resolve) => bus.on("TASK_FAILED", () => resolve()));

    await controller.run("click the button", 7);
    await failed;

    expect(state.navigations).toHaveLength(0);
    expect(reasons[0]).toContain("does not expose webpage controls");
    expect(controller.status.runtime).toBe("FAILED");
  });

  it("a Groq-like finish on chrome://newtab/ steers to the task destination instead of failing", async () => {
    const { adapter, state } = fakeNewtabWeb();
    const bus = new AgentEventBus();
    const outcome = new Promise<string>((resolve) => {
      bus.on("TASK_COMPLETED", (p) => resolve(`COMPLETED ${(p as { result?: string }).result}`));
      bus.on("TASK_FAILED", (p) => resolve(`FAILED ${(p as { reason?: string }).reason}`));
    });
    // Model gives up with finish while the page is internal, finishes
    // properly once a live page is reached.
    const planner = async (_t: unknown, _s: number, snap: ObservationSnapshot) => ({
      action: (snap.pageType === "unsupported"
        ? { action: "finish", result: "cannot act here" }
        : { action: "finish", result: "done on live page" }) as import("@/shared/action-schema").AgentAction,
      justification: "groq-sim",
    });
    const controller = new AgentController(adapter, bus, planner as never);
    bus.on("USER_INPUT_REQUIRED", () => controller.confirm());

    await controller.run("search youtube tutorial", 7);

    expect(await outcome).toBe("COMPLETED done on live page");
    expect(state.navigations).toHaveLength(1);
    expect(state.navigations[0]).toContain("google.com");
    expect(controller.status.runtime).toBe("COMPLETED");
  }, 30000);

  it("an invented page-level action on chrome://newtab/ steers to navigation (no retry exhaustion)", async () => {
    const { adapter, state } = fakeNewtabWeb();
    const bus = new AgentEventBus();
    const outcome = new Promise<string>((resolve) => {
      bus.on("TASK_COMPLETED", (p) => resolve(`COMPLETED ${(p as { result?: string }).result}`));
      bus.on("TASK_FAILED", (p) => resolve(`FAILED ${(p as { reason?: string }).reason}`));
    });
    const planner = async (_t: unknown, _s: number, snap: ObservationSnapshot) => ({
      action: (snap.pageType === "unsupported"
        ? { action: "click", target: { elementId: "el_999" } }
        : { action: "finish", result: "done on live page" }) as import("@/shared/action-schema").AgentAction,
      justification: "groq-sim",
    });
    const controller = new AgentController(adapter, bus, planner as never);
    bus.on("USER_INPUT_REQUIRED", () => controller.confirm());

    await controller.run("search youtube tutorial", 7);

    expect(await outcome).toBe("COMPLETED done on live page");
    expect(state.navigations).toHaveLength(1);
    expect(controller.status.runtime).toBe("COMPLETED");
  }, 30000);

  it("post-navigation observation and verification use the NEW page state", async () => {
    const { adapter } = fakeNewtabWeb();
    const bus = new AgentEventBus();
    const seenUrls: string[] = [];
    const evidence: string[][] = [];
    let navigated = false;
    bus.on("OBSERVATION_UPDATED", ({ snapshot }) => {
      if (navigated) seenUrls.push(snapshot.url);
    });
    bus.on("ACTION_SUCCEEDED", ({ action }) => {
      if (action.action === "navigate") navigated = true;
    });
    bus.on("VERIFICATION_SUCCEEDED", ({ evidence: e }) => evidence.push(e as string[]));
    const planner = async (_t: unknown, _s: number, snap: ObservationSnapshot) => ({
      action: (snap.pageType === "unsupported"
        ? { action: "navigate", url: "https://www.youtube.com/", expectedOutcome: { type: "url_change", urlContains: "youtube.com" } }
        : { action: "finish", result: "done" }) as import("@/shared/action-schema").AgentAction,
      justification: "groq-sim",
    });
    const controller = new AgentController(adapter, bus, planner as never);
    bus.on("USER_INPUT_REQUIRED", () => controller.confirm());
    const completed = new Promise<void>((resolve) => bus.on("TASK_COMPLETED", () => resolve()));

    await controller.run("search youtube tutorial", 7);
    await completed;

    // No observation after navigation may reference the old internal page…
    expect(seenUrls.length).toBeGreaterThan(0);
    for (const url of seenUrls) expect(url).not.toContain("chrome://");
    // …and navigation verification evidence names the NEW state.
    expect(evidence.some((lines) => lines.some((l) => l.includes("youtube.com")))).toBe(true);
    expect(controller.status.runtime).toBe("COMPLETED");
  }, 30000);

  it("tolerates a stale pre-commit tab URL after navigation, then observes live", async () => {
    // The tab still reports chrome://newtab/ for the first polls after
    // navigateTab resolves (navigation not yet committed). The loop must
    // wait through it instead of failing instantly.
    const committed = { url: "chrome://newtab/", polls: 0 };
    const { adapter, state } = fakeNewtabWeb();
    adapter.queryActiveTab = async () => ({ id: 7, url: committed.url, title: "Tab" });
    (adapter as { getTab: (id: number) => Promise<{ id: number; url: string } | null> }).getTab = async (id: number) => {
      committed.polls++;
      if (committed.polls >= 3) committed.url = state.url;
      return { id, url: committed.url };
    };
    const innerSend = adapter.sendToTabAndRespond;
    adapter.sendToTabAndRespond = async (tabId: number, message: unknown) => {
      const type = (message as { type?: string })?.type;
      if ((type === "CTX_PING" || type === "CTX_OBSERVE") && committed.url.startsWith("chrome://")) {
        return type === "CTX_PING"
          ? { type: "CTX_PING_RESULT", payload: { error: "unsupported_page" } }
          : { type: "CTX_OBSERVE_RESULT", payload: { error: "unsupported_page" } };
      }
      return innerSend(tabId, message);
    };
    const bus = new AgentEventBus();
    const completed = new Promise<void>((resolve) => bus.on("TASK_COMPLETED", () => resolve()));
    const controller = new AgentController(adapter, bus);
    bus.on("USER_INPUT_REQUIRED", () => controller.confirm());

    await controller.run("search youtube tutorial", 7);
    await completed;

    expect(state.navigations).toHaveLength(1);
    expect(state.results).toBe(true);
    expect(controller.status.runtime).toBe("COMPLETED");
  }, 30000);

  it("a confirmed internal destination still fails fast and honestly", async () => {
    const { adapter, state } = fakeNewtabWeb();
    (adapter as { getTab: (id: number) => Promise<{ id: number; url: string } | null> }).getTab =
      async (id: number) => ({ id, url: "chrome://settings/" });
    // The relay (router ensure) rejects the internal destinationcurl; only
    // live http(s) pages answer.
    const innerSend = adapter.sendToTabAndRespond;
    adapter.sendToTabAndRespond = async (tabId: number, message: unknown) => {
      const type = (message as { type?: string })?.type;
      if (state.url.startsWith("chrome://")) {
        return type === "CTX_PING"
          ? { type: "CTX_PING_RESULT", payload: { error: "unsupported_page" } }
          : { type: "CTX_OBSERVE_RESULT", payload: { error: "unsupported_page" } };
      }
      return innerSend(tabId, message);
    };
    const bus = new AgentEventBus();
    const reasons: string[] = [];
    bus.on("TASK_FAILED", ({ reason }) => reasons.push(reason));
    const planner = async () => ({
      action: { action: "navigate", url: "chrome://settings/" } as import("@/shared/action-schema").AgentAction,
      justification: "test",
    });
    const controller = new AgentController(adapter, bus, planner as never);
    const failed = new Promise<void>((resolve) => bus.on("TASK_FAILED", () => resolve()));
    const t0 = Date.now();

    await controller.run("search youtube tutorial", 7);
    await failed;

    expect(Date.now() - t0).toBeLessThan(10000);
    expect(reasons[0]).toContain("cannot be controlled");
    expect(controller.status.runtime).toBe("FAILED");
  }, 30000);

  it("a dead relay (__error envelope) fails honestly as extension-not-detected", async () => {    const { adapter } = fakeNewtabWeb();
    adapter.sendToTabAndRespond = async () => ({ __error: "Could not establish connection" });
    const bus = new AgentEventBus();
    const reasons: string[] = [];
    bus.on("TASK_FAILED", ({ reason }) => reasons.push(reason));
    const controller = new AgentController(adapter, bus);
    const failed = new Promise<void>((resolve) => bus.on("TASK_FAILED", () => resolve()));

    await controller.run("search youtube tutorial", 7);
    await failed;

    expect(reasons[0]).toContain("not detected");
    expect(controller.status.runtime).toBe("FAILED");
  });

  it("rejects an observation from the wrong tab, re-syncs, and continues", async () => {    const web = fakeWeb();
    let observes = 0;
    const inner = web.adapter.sendToTabAndRespond;
    web.adapter.sendToTabAndRespond = async (tabId: number, message: unknown) => {
      const reply = (await inner(tabId, message)) as any;
      // First observation arrives stamped for another tab (race); the rest
      // are correctly stamped for the working tab.
      if ((message as { type?: string })?.type === "CTX_OBSERVE") {
        observes++;
        if (observes === 1) {
          return { type: "CTX_OBSERVE_RESULT", payload: { ...web.snapshot(), tabId: 8 } };
        }
        return { type: "CTX_OBSERVE_RESULT", payload: { ...web.snapshot(), tabId: 7 } };
      }
      return reply;
    };

    const bus = new AgentEventBus();
    const controller = new AgentController(web.adapter, bus);
    bus.on("USER_INPUT_REQUIRED", () => controller.confirm());
    const completed = new Promise<void>((resolve) => bus.on("TASK_COMPLETED", () => resolve()));
    await controller.run("search youtube tutorial", 7);
    await completed;

    expect(observes).toBeGreaterThan(1);
    expect(controller.status.runtime).toBe("COMPLETED");
  });
});

describe("Phase 5 — the loop gates model-sourced consequential actions", () => {
  it("holds a Groq-proposed payment click with zero execution until the user confirms", async () => {
    const { adapter } = fakeWeb();
    const sentTypes: string[] = [];
    const original = adapter.sendToTabAndRespond;
    adapter.sendToTabAndRespond = async (t: number, m: unknown) => {
      const type = (m as { type?: string })?.type;
      if (type) sentTypes.push(type);
      const res = (await original(t, m)) as {
        type?: string;
        payload?: { elements?: Array<{ id?: string; name?: string }> };
      };
      // Fixture truthfulness: the planner's "Pay now" label must actually
      // describe el_002, otherwise the safety gate (correctly) invalidates
      // the approval as a label mismatch instead of executing.
      if (type === "CTX_OBSERVE" && Array.isArray(res?.payload?.elements)) {
        for (const e of res.payload.elements) {
          if (e.id === "el_002") e.name = "Pay now";
        }
      }
      return res;
    };

    const bus = new AgentEventBus();
    let plans = 0;
    // Simulates a Groq planner: first a confident payment click, then finish.
    const groqPlanner = () => {
      plans++;
      if (plans === 1) {
        return {
          action: {
            action: "click" as const,
            target: { elementId: "el_002", name: "Pay now" },
            confidence: 0.99,
            expectedOutcome: { type: "content_change" as const },
          },
          justification: "groq: pay now",
        };
      }
      return {
        action: { action: "finish" as const, result: "done", confidence: 0.99 },
        justification: "groq: done",
      };
    };
    const controller = new AgentController(adapter, bus, groqPlanner);

    const reasons: string[] = [];
    const held = new Promise<void>((resolve) =>
      bus.on("USER_INPUT_REQUIRED", ({ reason }) => {
        reasons.push(reason);
        resolve();
      }),
    );
    const completed = new Promise<void>((resolve) => bus.on("TASK_COMPLETED", () => resolve()));
    const runPromise = controller.run("buy the item", 7);
    await held;

    // Held at the gate: observed and validated, but nothing executed.
    expect(reasons[0]).toMatch(/financial|payment/i);
    expect(sentTypes).not.toContain("CTX_EXECUTE");

    controller.confirm();
    await runPromise;
    await completed;
    // Only after explicit approval did the click execute.
    expect(sentTypes).toContain("CTX_EXECUTE");
    expect(controller.status.runtime).toBe("COMPLETED");
  });

  it("executes a task through AgentController using GatewayLlmProvider", async () => {
    const { adapter } = fakeWeb();
    const bus = new AgentEventBus();
    let stepCount = 0;

    const mockFetch = vi.fn(async (url: string) => {
      if (url.endsWith("/health")) {
        return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      }
      stepCount++;
      if (stepCount === 1) {
        return new Response(
          JSON.stringify({
            action: {
              action: "type",
              target: { elementId: "el_001" },
              text: "hello world",
              expectedOutcome: { type: "content_change" },
            },
            model: "openai/gpt-oss-20b",
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          action: {
            action: "finish",
            result: "task complete",
          },
          model: "openai/gpt-oss-20b",
        }),
        { status: 200 },
      );
    });

    const gateway = new GatewayLlmProvider({ fetchFn: mockFetch as any });
    const planner = buildLlmPlanner(gateway);
    const controller = new AgentController(adapter, bus, planner);

    const completed = new Promise<void>((resolve) => bus.on("TASK_COMPLETED", () => resolve()));
    await controller.run("type into search", 7);
    await completed;

    expect(stepCount).toBeGreaterThanOrEqual(1);
    expect(controller.status.runtime).toBe("COMPLETED");
  });
});