/**
 * The Action Timeline must come from the REAL plan — not the generic local
 * heuristics. Covers: a Groq plan driving PLAN_CHANGED (task-specific steps,
 * source "groq"), per-task plan variation, labeled fallback (plan source
 * "local" + reason), and a re-plan that replaces the remaining steps.
 */
import { describe, it, expect } from "vitest";
import { AgentController } from "@/agent/controller";
import { AgentEventBus } from "@/shared/event-bus";
import { GatewayLlmProvider } from "@/llm/gateway-provider";
import { buildLlmPlanner } from "@/agent/llm-planner";
import type { BrowserAdapter } from "@/browser";
import type { ObservationSnapshot, ActionResult } from "@/shared/messages";
import type { AgentAction } from "@/shared/action-schema";
import type { PlanMeta, TaskData, TaskStep } from "@/shared/types";
import { interpretTask } from "@/agent/task-interpreter";

const YT_HOME = "https://www.youtube.com/";
const YT_RESULTS = "https://www.youtube.com/results?search_query=beginner";
const YT_WATCH = "https://www.youtube.com/watch?v=abc";

const el = (id: string, role: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, role, name, tag: role === "link" ? "a" : "input", visible: true, enabled: true, focused: false,
  rect: { x: 0, y: 0, w: 50, h: 20 }, ...extra,
});

type PlanStepLike = { id: string; description: string };

type BackendData = {
  interpretation?: string;
  inputs?: Record<string, string>;
  generatedData?: Record<string, string>;
};

function planSteps(texts: string[]): PlanStepLike[] {
  return texts.map((t, i) => ({ id: `step_${i + 1}`, description: t }));
}

const PLAN_A = planSteps([
  "Open YouTube home",
  'Type "beginner C language tutorial" into the YouTube search box',
  "Press Enter on the search box",
  "Open the top C tutorial result video",
  "Confirm the video is playing",
]);

const PLAN_B = planSteps([
  'Open YouTube and search "best budget laptops under ₹50,000"',
  "Press Enter on the search box",
  "Open the first review video",
  "Summarize the comparison",
]);

const PLAN_C = planSteps([
  'Search YouTube for "beginner C tutorial"',
  "Open the first video",
  "Confirm playback",
]);

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

/**
 * Backend-identical StepResponse. The plan rides on the first decision
 * (history empty) and — when `replan` is given — on the results page; the
 * failing observation triggers one 503 to exercise the labeled fallback.
 */
function scriptedBackend(opts: {
  plan?: PlanStepLike[];
  replan?: PlanStepLike[];
  failAt?: string;
  data?: BackendData;
} = { plan: PLAN_A }) {
  let failed = false;
  return async (url: string, init?: { body?: string }) => {
    if (url.endsWith("/health")) {
      return { ok: true, status: 200, json: async () => ({ status: "ok" }) };
    }
    const body = JSON.parse(init?.body ?? "{}");
    const obs = body.observation as { url: string; elements?: Array<{ id?: string; role?: string }> };
    if (opts.failAt && obs.url === opts.failAt && !failed) {
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
    const firstDecision = !(body.history as string[]).length;
    let plan: PlanStepLike[] | undefined;
    if (firstDecision) plan = opts.plan;
    else if (opts.replan && obs.url.startsWith(YT_RESULTS)) plan = opts.replan;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        action,
        model: "openai/gpt-oss-20b",
        usage: {},
        plan,
        inputs: firstDecision ? opts.data?.inputs : undefined,
        generatedData: firstDecision ? opts.data?.generatedData : undefined,
        interpretation: firstDecision ? opts.data?.interpretation : undefined,
      }),
    };
  };
}

async function runTask(opts: {
  goal?: string;
  plan?: PlanStepLike[];
  replan?: PlanStepLike[];
  failAt?: string;
  data?: BackendData;
} = {}) {
  const goal = opts.goal ?? "Find a beginner C language tutorial on YouTube.";
  const { adapter, state } = fakeYouTube();
  const bus = new AgentEventBus();
  const planEvents: Array<{ steps: TaskStep[]; meta: PlanMeta; data?: TaskData | null }> = [];
  const fallbacks: unknown[] = [];
  const succeeded: string[] = [];
  bus.on("PLAN_CHANGED", (p) => planEvents.push(p));
  bus.on("PROVIDER_FALLBACK", (p) => fallbacks.push(p));
  bus.on("ACTION_SUCCEEDED", ({ action }) => succeeded.push(action.action));
  bus.on("USER_INPUT_REQUIRED", () => {});
  const provider = new GatewayLlmProvider({
    fetchFn: scriptedBackend({
      plan: opts.plan ?? PLAN_A,
      replan: opts.replan,
      failAt: opts.failAt,
      data: opts.data,
    }) as never,
    healthTimeoutMs: 50,
  });
  const planner = buildLlmPlanner(provider);
  const controller = new AgentController(adapter, bus, planner);
  const outcome = new Promise<string>((resolve) => {
    bus.on("TASK_COMPLETED", (p) => resolve(`COMPLETED ${(p as { result?: string }).result}`));
    bus.on("TASK_FAILED", (p) => resolve(`FAILED ${(p as { reason?: string }).reason}`));
  });
  await controller.run(goal, 7);
  return { outcome: await outcome, planEvents, fallbacks, succeeded, finalUrl: state.url };
}

describe("Action Timeline rides the real Groq plan", () => {
  it("PLAN_CHANGED carries the Groq task-specific plan and drives statuses to done", async () => {
    const r = await runTask();
    expect(r.planEvents.length).toBeGreaterThan(0);
    const first = r.planEvents[0];
    expect(first.meta.source).toBe("groq");
    expect(first.meta.fallbackReason).toBeUndefined();
    expect(first.steps).toHaveLength(5);
    expect(first.steps[0].text).toContain("YouTube");
    // The real plan replaces the generic heuristic timeline.
    const flat = r.planEvents.flatMap((e) => e.steps.map((s) => s.text));
    expect(flat.some((t) => t.includes("navigate to the search engine"))).toBe(false);
    // At least the first two steps got verified done as the loop advanced.
    const last = r.planEvents[r.planEvents.length - 1];
    expect(last.steps.filter((s) => s.status === "done").length).toBeGreaterThanOrEqual(2);
    expect(r.succeeded).toEqual(["navigate", "type", "press_key", "click", "finish"]);
    expect(r.outcome).toContain("COMPLETED");
    expect(r.fallbacks).toHaveLength(0);
  }, 30000);

  it("plans differ per task — no universal timeline", async () => {
    const a = await runTask();
    const b = await runTask({ goal: "Compare three laptops under ₹50,000.", plan: PLAN_B });
    const textsA = a.planEvents[0].steps.map((s) => s.text);
    const textsB = b.planEvents[0].steps.map((s) => s.text);
    expect(textsB.join(" ")).toContain("laptops");
    expect(textsB.join(" ")).toContain("₹50,000");
    expect(textsA).not.toEqual(textsB);
  }, 30000);

  it("provider failure on the first decision seeds a LABELED local fallback plan", async () => {
    const goal = "Find a beginner C language tutorial on YouTube.";
    const r = await runTask({ failAt: "chrome://newtab/" });
    expect(r.fallbacks.length).toBeGreaterThanOrEqual(1);
    const first = r.planEvents[0];
    expect(first.meta.source).toBe("local");
    expect(first.meta.fallbackReason).toContain("local task-sourced plan");
    // The local plan is the heuristic task-sourced steps — now visibly labeled.
    const heuristic = interpretTask(goal).steps;
    expect(first.steps.map((s) => s.text)).toEqual(heuristic);
    expect(r.outcome).toContain("COMPLETED");
  }, 30000);

  it("a re-plan replaces the remaining steps and surfaces them as replaced", async () => {
    const r = await runTask({ replan: PLAN_C });
    const replacedSeen = r.planEvents.some((e) =>
      e.steps.some((s) => s.status === "replaced"),
    );
    expect(replacedSeen).toBe(true);
    // Immediately after the re-plan the revised steps are pending.
    const afterReplan = r.planEvents.find((e) => e.steps.some((s) => s.status === "replaced"));
    expect(afterReplan).toBeDefined();
    expect(afterReplan!.steps.some((s) => s.text.includes("Search YouTube"))).toBe(true);
    // Done prefix survived the re-plan.
    const event = afterReplan!;
    const doneBeforeReplaced = event.steps.indexOf(event.steps.find((s) => s.status === "replaced")!);
    expect(doneBeforeReplaced).toBeGreaterThanOrEqual(2);
    expect(r.outcome).toContain("COMPLETED");
  }, 30000);
});

describe("Task data rides the Groq plan with honest provenance", () => {
  it("inputs, generatedData and interpretation arrive with the first PLAN_CHANGED", async () => {
    const data: BackendData = {
      interpretation: "Fill the registration form with harmless sample data.",
      inputs: { name: "Arjun Singh" },
      generatedData: { first_name: "Rahul", course: "Computer Science" },
    };
    const r = await runTask({ data });
    const first = r.planEvents[0];
    expect(first.data?.interpretation).toBe("Fill the registration form with harmless sample data.");
    expect(first.data?.inputs).toEqual({ name: "Arjun Singh" });
    expect(first.data?.generated).toEqual({ first_name: "Rahul", course: "Computer Science" });
    // The panel keeps the data snapshot across later (data-less) emits.
    expect(r.planEvents[r.planEvents.length - 1].data?.generated).toEqual({
      first_name: "Rahul",
      course: "Computer Science",
    });
  }, 30000);

  it("secret-shaped generated keys are scrubbed client-side too (gateway contract)", async () => {
    const data: BackendData = {
      interpretation: "Fill the form with sample data.",
      generatedData: {
        first_name: "Rahul",
        password: "P@ssw0rd123",
        apiKey: "sk-proj-hunter2",
        phone: "9876543210",
      },
    };
    const r = await runTask({ data });
    const first = r.planEvents[0];
    expect(first.data?.generated).toEqual({
      first_name: "Rahul",
      phone: "9876543210",
    });
    const serialized = Object.entries(first.data?.generated ?? {}).map(([k, v]) => `${k}=${v}`).join("|");
    expect(serialized.toLowerCase()).not.toContain("password");
    expect(serialized.toLowerCase()).not.toContain("apikey");
  }, 30000);

  it("no data section when the provider sends none", async () => {
    const r = await runTask();
    const first = r.planEvents[0];
    expect(first.data ?? null).toBeNull();
  }, 30000);
});