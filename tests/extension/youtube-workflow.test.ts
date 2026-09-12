/**
 * Brief §28 A/C/E/G: the deterministic fallback path must drive a YouTube
 * task in the REAL browser loop — navigate → observe → type → submit →
 * select → open → verify → COMPLETED — with re-planning after a stale
 * target, and no search-engine detour.
 */
import { describe, it, expect } from "vitest";
import { AgentController } from "@/agent/controller";
import { AgentEventBus } from "@/shared/event-bus";
import { interpretTask } from "@/agent/task-interpreter";
import type { BrowserAdapter } from "@/browser";
import type { ObservationSnapshot, ActionResult } from "@/shared/messages";
import type { AgentAction } from "@/shared/action-schema";

const GOAL = "Search Python compiler on YouTube and play the first video.";
const YT_HOME = "https://www.youtube.com/";
const YT_RESULTS = "https://www.youtube.com/results?search_query=Python+compiler";
const YT_WATCH = "https://www.youtube.com/watch?v=py001";

const el = (id: string, role: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, role, name, tag: role === "link" ? "a" : "input", visible: true, enabled: true, focused: false,
  rect: { x: 0, y: 0, w: 50, h: 20 }, ...extra,
});

function fakeYouTube() {
  const state = { url: "chrome://newtab/", page: "newtab" as "newtab" | "home" | "results" | "watch", query: "" };

  const snapshot = (): ObservationSnapshot => {
    const base = { tabId: 7, viewport: { w: 1280, h: 800 }, scrollY: 0, scrollH: 2000, loading: false, createdAt: Date.now() };
    if (state.page === "home") {
      return {
        ...base, url: state.url, title: "YouTube", pageType: "content",
        visibleText: "YouTube Home Search Home Shorts Subscriptions Guide About Press Copyright",
        elements: [el("el_010", "searchbox", "Search", { value: state.query }), el("el_011", "button", "Search", { tag: "button" })],
        counted: 2,
      };
    }
    if (state.page === "results") {
      return {
        ...base, url: state.url, title: "Python compiler - YouTube", pageType: "content",
        visibleText: `Search results for ${state.query} Python compiler tutorial part 1 Python compiler tutorial part 2 Filters`,
        elements: [
          el("el_010", "searchbox", "Search", { value: state.query }),
          el("el_201", "link", "Python compiler tutorial part 1"),
          el("el_202", "link", "Python compiler tutorial part 2"),
        ],
        counted: 3,
      };
    }
    return {
      ...base, url: state.url, title: "Python compiler tutorial part 1 - YouTube", pageType: "content",
      visibleText: "Python compiler tutorial part 1 now showing Like Share Save",
      elements: [el("el_301", "button", "Like this video", { tag: "button" })],
      counted: 1,
    };
  };

  const adapter = {
    runtimeName: "chrome",
    queryActiveTab: async () => ({ id: 7, url: state.url, title: "" }),
    navigateTab: async (_t: number, url: string) => {
      state.url = url;
      state.page = "home";
    },
    reloadTab: async () => undefined,
    closeTab: async () => undefined,
    createTab: async () => null,
    listTabs: async () => [],
    activateTab: async () => undefined,
    goBackTab: async () => false,
    goForwardTab: async () => false,
    sendToTabAndRespond: async (_t: number, message: unknown): Promise<unknown> => {
      const msg = message as { type: string; payload?: { action?: AgentAction } };
      if (msg.type === "CTX_PING") {
        if (state.page === "newtab") return { type: "CTX_PING_RESULT", payload: { error: "unsupported_page" } };
        return { type: "CTX_PONG", payload: { ok: true, url: state.url } };
      }
      if (msg.type === "CTX_OBSERVE") {
        if (state.page === "newtab") return { type: "CTX_OBSERVE_RESULT", payload: { error: "unsupported_page" } };
        return { type: "CTX_OBSERVE_RESULT", payload: { ...snapshot(), tabId: 7 } };
      }
      if (msg.type === "CTX_EXECUTE") {
        const act = msg.payload?.action as AgentAction;
        if (act.action === "type") {
          state.query = act.text ?? "";
          return { type: "CTX_EXECUTE_RESULT", payload: { ok: true, hint: { value: act.text } } satisfies ActionResult };
        }
        if (act.action === "search") {
          state.query = act.text ?? state.query;
          state.url = YT_RESULTS;
          state.page = "results";
          return { type: "CTX_EXECUTE_RESULT", payload: { ok: true, hint: { value: state.query } } satisfies ActionResult };
        }
        if (act.action === "click") {
          state.url = YT_WATCH;
          state.page = "watch";
          return { type: "CTX_EXECUTE_RESULT", payload: { ok: true, hint: { text: "Python compiler tutorial" } } satisfies ActionResult };
        }
        if (act.action === "finish") {
          return { type: "CTX_EXECUTE_RESULT", payload: { ok: true } satisfies ActionResult };
        }
        return { type: "CTX_EXECUTE_RESULT", payload: { ok: false, error: "unhandled" } satisfies ActionResult };
      }
      return { ok: false };
    },
  } as unknown as BrowserAdapter;

  return { adapter, state };
}

describe("task interpretation (planning input)", () => {
  it("A. YouTube goals resolve to the platform, with media steps and a typed query", () => {
    const task = interpretTask(GOAL);
    expect(task.startUrl).toBe("https://www.youtube.com");
    expect(task.steps).toEqual([
      "open the video platform",
      "enter the query",
      "submit the search",
      "select a relevant result",
      "open the selected video",
      "verify the result",
    ]);
    expect(task.entities.find((e) => e.label === "query")?.value).toBe("Python compiler");
  });

  it("A. bare searches keep the search-engine start page", () => {
    const task = interpretTask("search youtube tutorial");
    expect(task.startUrl).toContain("google.com");
  });

  it("A. C-tutorial goal extracts the topic query", () => {
    const task = interpretTask("Open YouTube and find a beginner C language tutorial.");
    expect(task.startUrl).toBe("https://www.youtube.com");
    expect(task.entities.find((e) => e.label === "query")?.value).toBe("beginner C language tutorial");
  });

  it("§37. explicit YouTube constraint: destination YouTube, isolated query, never Google", () => {
    const task = interpretTask("Find a beginner C language tutorial on YouTube.");
    expect(task.startUrl).toBe("https://www.youtube.com");
    expect(task.startUrl).not.toContain("google");
    expect(task.entities.find((e) => e.label === "query")?.value).toBe("beginner C language tutorial");
    expect(task.steps[0]).toBe("open the video platform");
  });

  it("site discovery: unspecified destination keeps the search-engine start page", () => {
    const task = interpretTask("Find a beginner C tutorial.");
    expect(task.startUrl).toContain("google.com");
    expect(task.entities.find((e) => e.label === "query")?.value).toBe("beginner C tutorial");
  });

  it("explicit Amazon constraint routes to Amazon directly, never Google", () => {
    const task = interpretTask("Find this laptop on Amazon.");
    expect(task.startUrl).toBe("https://www.amazon.com");
    expect(task.startUrl).not.toContain("google");
  });
});

describe("YouTube workflow through the real loop (deterministic fallback)", () => {
  it("G+C. navigate → type → submit → select → open → verify → COMPLETED", async () => {
    const { adapter, state } = fakeYouTube();
    const bus = new AgentEventBus();
    const succeeded: string[] = [];
    bus.on("ACTION_SUCCEEDED", ({ action }) => succeeded.push(action.action));
    bus.on("USER_INPUT_REQUIRED", () => {});
    const completed = new Promise<string>((resolve) => {
      bus.on("TASK_COMPLETED", (p) => resolve((p as { result?: string }).result ?? ""));
      bus.on("TASK_FAILED", (p) => resolve(`FAILED ${(p as { reason?: string }).reason}`));
    });
    // Default deterministic planner (no LLM): the fallback path under test.
    const controller = new AgentController(adapter, bus);

    await controller.run(GOAL, 7);

    expect(state.url).toBe(YT_WATCH);
    expect(state.query).toBe("Python compiler");
    expect(succeeded).toEqual(["navigate", "type", "search", "click", "finish"]);
    expect(await completed).not.toMatch(/^FAILED/);
    expect(controller.status.runtime).toBe("COMPLETED");
  }, 30000);

  it("E. a stale target fails validation, then re-plans against fresh state", async () => {
    const { adapter, state } = fakeYouTube();
    // Start live on the YouTube homepage (skip navigation for this case).
    state.url = YT_HOME;
    (state as { page: string }).page = "home";
    const bus = new AgentEventBus();
    const seen: string[] = [];
    let calls = 0;
    const planner = async (_t: unknown, _s: number, snap: ObservationSnapshot) => {
      calls++;
      seen.push(snap.url);
      if (calls === 1) {
        return { action: { action: "click", target: { elementId: "el_stale" } } as AgentAction, justification: "stale" };
      }
      return { action: { action: "finish", result: "recovered with fresh observation" } as AgentAction, justification: "fresh" };
    };
    const controller = new AgentController(adapter, bus, planner as never);
    const completed = new Promise<string>((resolve) => {
      bus.on("TASK_COMPLETED", (p) => resolve((p as { result?: string }).result ?? ""));
      bus.on("TASK_FAILED", (p) => resolve(`FAILED ${(p as { reason?: string }).reason}`));
    });

    await controller.run("Search Python compiler on YouTube and play the first video.", 7);

    // Validation rejected the stale id, the loop re-observed and asked
    // again instead of executing blindly or hanging.
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(seen.every((u) => u === YT_HOME)).toBe(true);
    expect(await completed).toBe("recovered with fresh observation");
    expect(controller.status.runtime).toBe("COMPLETED");
  }, 30000);
});
