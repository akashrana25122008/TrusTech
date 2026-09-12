/**
 * Regression test: "Open YouTube and find a beginner C language tutorial."
 * must NOT stop after the first navigation.
 *
 * Covers the premature-completion defect where the completion detector read
 * YouTube's homepage (recommendations/chrome mention goal keywords) as task
 * completion and ended the loop with "goal keywords (N) match page content"
 * before the agent searched, selected, and opened a video.
 */
import { describe, it, expect } from "vitest";
import { AgentController } from "@/agent/controller";
import { AgentEventBus } from "@/shared/event-bus";
import { checkCompletion } from "@/agent/completion-detector";
import { interpretTask } from "@/agent/task-interpreter";
import type { BrowserAdapter } from "@/browser";
import type { ObservationSnapshot, ActionResult } from "@/shared/messages";
import type { AgentAction } from "@/shared/action-schema";

const GOAL = "Open YouTube and find a beginner C language tutorial.";
const YT_HOME = "https://www.youtube.com/";
const YT_RESULTS = "https://www.youtube.com/results?search_query=beginner+C+language+tutorial";
const YT_WATCH = "https://www.youtube.com/watch?v=abc123";

const el = (id: string, role: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, role, name, tag: "input", visible: true, enabled: true, focused: false,
  rect: { x: 0, y: 0, w: 50, h: 20 }, ...extra,
});

/** Rendered-homepage-like text including the coding recommendations a user
 *  interested in C tutorials would realistically see. */
const YT_HOME_TEXT =
  "Guide YouTube Home Search Search with your voice Home Shorts Subscriptions " +
  "You History Playlists Watch Later Liked videos Subscriptions Show more Explore " +
  "Trending Music Gaming News Sports All Music Coding Podcasts Live " +
  "C Language Tutorial for Beginners Learn C Programming full course " +
  "Tips and Tricks for New Coders Open Source Projects explained " +
  "About Press Copyright Contact us Creators Advertise Developers Terms Privacy " +
  "Policy & Safety How YouTube works Test new features 2026 Google LLC";

function makeWorld() {
  const state = {
    url: "chrome://newtab/",
    page: "newtab" as "newtab" | "home" | "results" | "watch",
    query: "",
  };

  const snapshot = (): ObservationSnapshot => {
    if (state.page === "home") {
      return {
        url: state.url, title: "YouTube", tabId: 7, pageType: "content",
        viewport: { w: 1280, h: 800 }, scrollY: 0, scrollH: 2000, loading: false,
        visibleText: YT_HOME_TEXT,
        elements: [
          el("el_010", "searchbox", "Search", { value: state.query }),
          el("el_011", "button", "Search", { tag: "button" }),
        ],
        counted: 2, createdAt: Date.now(),
      };
    }
    if (state.page === "results") {
      return {
        url: state.url, title: "beginner C language tutorial - YouTube", tabId: 7, pageType: "content",
        viewport: { w: 1280, h: 800 }, scrollY: 0, scrollH: 3000, loading: false,
        visibleText: `Search results for ${state.query} C Language Tutorial for Beginners video`,
        elements: [
          el("el_010", "searchbox", "Search", { value: state.query }),
          el("el_201", "link", "C Language Tutorial for Beginners", { tag: "a" }),
        ],
        counted: 2, createdAt: Date.now(),
      };
    }
    return {
      url: state.url, title: "C Language Tutorial for Beginners - YouTube", tabId: 7, pageType: "content",
      viewport: { w: 1280, h: 800 }, scrollY: 0, scrollH: 1500, loading: false,
      visibleText: "C Language Tutorial for Beginners video playing",
      elements: [el("el_301", "button", "Like this video", { tag: "button" })],
      counted: 1, createdAt: Date.now(),
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
        if (act.action === "press_key") {
          state.url = YT_RESULTS;
          state.page = "results";
          return { type: "CTX_EXECUTE_RESULT", payload: { ok: true } satisfies ActionResult };
        }
        if (act.action === "click") {
          state.url = YT_WATCH;
          state.page = "watch";
          return { type: "CTX_EXECUTE_RESULT", payload: { ok: true, hint: { text: "C Language Tutorial" } } satisfies ActionResult };
        }
        if (act.action === "finish") {
          return { type: "CTX_EXECUTE_RESULT", payload: { ok: true } satisfies ActionResult };
        }
        return { type: "CTX_EXECUTE_RESULT", payload: { ok: false, error: "unhandled" } satisfies ActionResult };
      }
      return { ok: false };
    },
  } as unknown as BrowserAdapter;

  // Observation-driven planner (Groq-like): navigate → type → Enter → click → finish.
  const planned: string[] = [];
  const planner = async (
    _task: unknown, _step: number, snap: ObservationSnapshot,
  ): Promise<{ action: AgentAction; justification: string } | null> => {
    let action: AgentAction;
    if (snap.pageType === "unsupported") {
      action = { action: "navigate", url: YT_HOME, expectedOutcome: { type: "url_change", urlContains: "youtube.com" } };
    } else if (snap.url === YT_HOME && !state.query) {
      action = { action: "type", target: { elementId: "el_010" }, text: "beginner C language tutorial", expectedOutcome: { type: "element_state" } };
    } else if (snap.url === YT_HOME) {
      action = { action: "press_key", key: "Enter", expectedOutcome: { type: "content_change" } };
    } else if (snap.url.startsWith("https://www.youtube.com/results")) {
      action = { action: "click", target: { elementId: "el_201" }, expectedOutcome: { type: "url_change", urlContains: "watch" } };
    } else {
      action = { action: "finish", result: "Opened beginner C tutorial on YouTube" };
    }
    planned.push(action.action);
    return { action, justification: "groq-sim" };
  };

  return { adapter, state, planned, planner: planner as never };
}

describe("youtube multi-step task", () => {
  it("runs the full loop: navigate → type → submit → click → finish", async () => {
    const { adapter, state, planned, planner } = makeWorld();
    const bus = new AgentEventBus();
    const outcome = new Promise<string>((resolve) => {
      bus.on("TASK_COMPLETED", (p) => resolve(`COMPLETED: ${(p as { result?: string }).result}`));
      bus.on("TASK_FAILED", (p) => resolve(`FAILED: ${(p as { reason?: string }).reason}`));
    });
    const controller = new AgentController(adapter, bus, planner);
    bus.on("USER_INPUT_REQUIRED", () => controller.confirm());
    await controller.run(GOAL, 7);
    expect(await outcome).toBe("COMPLETED: Opened beginner C tutorial on YouTube");
    expect(planned).toEqual(["navigate", "type", "press_key", "click", "finish"]);
    expect(state.url).toBe(YT_WATCH);
    expect(controller.status.runtime).toBe("COMPLETED");
  }, 30000);

  it("keyword-rich homepage is not completion after navigation alone", () => {
    const task = interpretTask(GOAL);
    const snap = (text: string): ObservationSnapshot => ({
      url: YT_HOME, title: "YouTube", tabId: 7, pageType: "content",
      viewport: { w: 1, h: 1 }, scrollY: 0, scrollH: 0, loading: false,
      visibleText: text, elements: [], counted: 0, createdAt: 1,
    });
    const mem = [
      { kind: "executed", action: { action: "navigate", url: YT_HOME }, ok: true, ts: 1 },
    ] as never[];
    // 6 goal tokens match the homepage, yet the task is not done.
    expect(checkCompletion(task, snap(YT_HOME_TEXT), mem).done).toBe(false);
  });
});
