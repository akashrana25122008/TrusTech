/**
 * Master-loop Attempt 1b — REAL Groq path loop in the extension runtime:
 * AgentController + buildLlmPlanner + GatewayLlmProvider (real classes),
 * with fetch bridged to scripted backend-identical StepResponses keyed by
 * the CURRENT observation (proves the 2nd+ Groq decisions use fresh
 * YouTube state, never stale newtab state). Attempt 2 injects a gateway
 * failure to prove the fallback is labeled, not silent.
 */
import { describe, it, expect } from "vitest";
import { AgentController } from "@/agent/controller";
import { AgentEventBus } from "@/shared/event-bus";
import { GatewayLlmProvider } from "@/llm/gateway-provider";
import { buildLlmPlanner } from "@/agent/llm-planner";
import type { BrowserAdapter } from "@/browser";
import type { ObservationSnapshot, ActionResult } from "@/shared/messages";
import type { AgentAction } from "@/shared/action-schema";

const GOAL = "Find a beginner C language tutorial on YouTube.";
const YT_HOME = "https://www.youtube.com/";
const YT_RESULTS = "https://www.youtube.com/results?search_query=beginner";
const YT_WATCH = "https://www.youtube.com/watch?v=abc";

const el = (id: string, role: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, role, name, tag: role === "link" ? "a" : "input", visible: true, enabled: true, focused: false,
  rect: { x: 0, y: 0, w: 50, h: 20 }, ...extra,
});

function fakeYouTube() {
  const state = { url: "chrome://newtab/", page: "newtab" as "newtab" | "home" | "results" | "watch", query: "" };
  const snapshot = (): ObservationSnapshot => {
    const base = { tabId: 7, viewport: { w: 1280, h: 800 }, scrollY: 0, scrollH: 500, loading: false, createdAt: Date.now() };
    if (state.page === "home") {
      return {
        ...base, url: state.url, title: "YouTube", pageType: "content",
        visibleText: "YouTube Home Search Shorts Guide About",
        elements: [el("el_010", "searchbox", "Search", { value: state.query })],
        counted: 1,
      };
    }
    if (state.page === "results") {
      return {
        ...base, url: state.url, title: "results - YouTube", pageType: "content",
        visibleText: `Search results for ${state.query} C Language Tutorial for Beginners part 1 part 2`,
        elements: [el("el_010", "searchbox", "Search", { value: state.query }), el("el_201", "link", "C Language Tutorial for Beginners")],
        counted: 2,
      };
    }
    return {
      ...base, url: state.url, title: "C Language Tutorial for Beginners - YouTube", pageType: "content",
      visibleText: "C Language Tutorial for Beginners now showing Like Share",
      elements: [el("el_301", "button", "Like this video", { tag: "button" })],
      counted: 1,
    };
  };
  const adapter = {
    runtimeName: "chrome",
    queryActiveTab: async () => ({ id: 7, url: state.url, title: "" }),
    navigateTab: async (_t: number, url: string) => { state.url = url; state.page = "home"; },
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
          state.url = YT_RESULTS; state.page = "results";
          return { type: "CTX_EXECUTE_RESULT", payload: { ok: true } satisfies ActionResult };
        }
        if (act.action === "click") {
          state.url = YT_WATCH; state.page = "watch";
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
  return { adapter, state };
}

/** Backend-identical StepResponse keyed by CURRENT observation (Groq stand-in). */
function scriptedFetch(seen: Array<{ url: string; history: string[] }>, failOnceAt?: string) {
  let failed = false;
  return async (url: string, init?: { body?: string }) => {
    if (url.endsWith("/health")) {
      return { ok: true, status: 200, json: async () => ({ status: "ok" }) };
    }
    const body = JSON.parse(init?.body ?? "{}");
    const obs = body.observation as { url: string; elements?: Array<{ id?: string; role?: string }> };
    seen.push({ url: obs.url, history: body.history as string[] });
    if (failOnceAt && obs.url === failOnceAt && !failed) {
      failed = true;
      return { ok: false, status: 503, json: async () => ({ detail: "reasoning engine unavailable" }) };
    }
    let action: AgentAction;
    if (obs.url.includes("chrome://")) {
      action = { action: "navigate", url: YT_HOME, expectedOutcome: { type: "url_change", urlContains: "youtube.com" } };
    } else if (obs.url === YT_HOME && !(body.history as string[]).some((h) => h.startsWith("type"))) {
      const box = (obs.elements ?? []).find((e) => e.role === "searchbox");
      action = { action: "type", target: { elementId: box?.id ?? "el_010" }, text: "beginner C language tutorial", expectedOutcome: { type: "element_state" } };
    } else if (obs.url === YT_HOME) {
      action = { action: "press_key", key: "Enter", expectedOutcome: { type: "content_change" } };
    } else if (obs.url.startsWith(YT_RESULTS)) {
      action = { action: "click", target: { elementId: "el_201" }, expectedOutcome: { type: "url_change", urlContains: "watch" } };
    } else {
      action = { action: "finish", result: "Opened beginner C tutorial on YouTube" };
    }
    return { ok: true, status: 200, json: async () => ({ action, model: "openai/gpt-oss-20b", usage: {} }) };
  };
}

async function runTask(opts: { failGatewayAt?: string } = {}) {
  const { adapter, state } = fakeYouTube();
  const bus = new AgentEventBus();
  const seen: Array<{ url: string; history: string[] }> = [];
  const fallbacks: unknown[] = [];
  const succeeded: string[] = [];
  bus.on("PROVIDER_FALLBACK", (p) => fallbacks.push(p));
  bus.on("ACTION_SUCCEEDED", ({ action }) => succeeded.push(action.action));
  bus.on("USER_INPUT_REQUIRED", () => {});
  const provider = new GatewayLlmProvider({
    fetchFn: scriptedFetch(seen, opts.failGatewayAt) as never,
    healthTimeoutMs: 50,
  });
  const planner = buildLlmPlanner(provider);
  const controller = new AgentController(adapter, bus, planner);
  const outcome = new Promise<string>((resolve) => {
    bus.on("TASK_COMPLETED", (p) => resolve(`COMPLETED ${(p as { result?: string }).result}`));
    bus.on("TASK_FAILED", (p) => resolve(`FAILED ${(p as { reason?: string }).reason}`));
  });
  await controller.run(GOAL, 7);
  return { outcome: await outcome, seen, fallbacks, succeeded, finalUrl: state.url, runtime: controller.status.runtime };
}

describe("master loop — real Groq path (Attempt 1)", () => {
  it("canonical task completes through GatewayLlmProvider with fresh observations each step", async () => {
    const r = await runTask();
    // Groq decisions used current state every time: 2nd+ requests carry YouTube URLs.
    const urls = r.seen.map((s) => s.url);
    expect(urls[0]).toContain("chrome://");
    expect(urls.slice(1).every((u) => u.includes("youtube.com"))).toBe(true);
    // History + verification accumulate across iterations (loop continuation proof).
    expect(r.seen[r.seen.length - 1].history.length).toBeGreaterThan(2);
    expect(r.succeeded).toEqual(["navigate", "type", "press_key", "click", "finish"]);
    expect(r.finalUrl).toBe(YT_WATCH);
    expect(r.outcome).toBe("COMPLETED Opened beginner C tutorial on YouTube");
    expect(r.fallbacks).toHaveLength(0);
    expect(r.runtime).toBe("COMPLETED");
  }, 30000);
});

describe("master loop — gateway failure is labeled, loop continues (Attempt 2)", () => {
  it("503 on the homepage step emits PROVIDER_FALLBACK and the task still completes", async () => {
    const r = await runTask({ failGatewayAt: YT_HOME });
    expect(r.fallbacks.length).toBeGreaterThanOrEqual(1);
    expect(r.fallbacks[0]).toMatchObject({ provider: "groq-gateway", stage: "request" });
    expect(r.runtime).toBe("COMPLETED");
    expect(r.finalUrl).toBe(YT_WATCH);
  }, 30000);
});
