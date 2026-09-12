/**
 * Forensic lifecycle coverage for the Groq gateway path and the agent loop:
 * classified provider failures (never a bare "unavailable"), abort/timeout
 * split, and terminal-state guards (stop/overlap/late-results cannot
 * restart or mutate a finished task).
 */
import { describe, it, expect, vi } from "vitest";
import { AgentController } from "@/agent/controller";
import { AgentEventBus } from "@/shared/event-bus";
import { GatewayLlmProvider, classifyGatewayError } from "@/llm/gateway-provider";
import { buildLlmPlanner, type ActionPlanner } from "@/agent/llm-planner";
import { interpretTask } from "@/agent/task-interpreter";
import type { PlannerAction } from "@/agent/deterministic-planner";
import type { BrowserAdapter } from "@/browser";
import type { ObservationSnapshot } from "@/shared/messages";

function snap(): ObservationSnapshot {
  return {
    url: "https://example.com",
    title: "Example",
    tabId: 7,
    pageType: "content",
    viewport: { w: 1000, h: 800 },
    scrollY: 0,
    scrollH: 800,
    loading: false,
    visibleText: "Welcome to the example page",
    elements: [
      { id: "el_001", role: "link", name: "More information", tag: "a", visible: true, enabled: true, focused: false, rect: { x: 0, y: 0, w: 50, h: 20 } },
    ],
    counted: 1,
    createdAt: Date.now(),
  };
}

/** Minimal live bridge: handshake + observe + execute succeed. Counts calls. */
function stubBridge() {
  const calls: string[] = [];
  const adapter = {
    runtimeName: "chrome",
    queryActiveTab: async () => ({ id: 7, url: "https://example.com", title: "Example" }),
    navigateTab: async () => undefined,
    sendToTabAndRespond: async (_t: number, message: unknown): Promise<unknown> => {
      const msg = message as { type: string; payload?: { action?: { action?: string } } };
      calls.push(msg.type);
      if (msg.type === "CTX_PING") return { type: "CTX_PONG", payload: { ok: true, url: "https://example.com" } };
      if (msg.type === "CTX_OBSERVE") return { type: "CTX_OBSERVE_RESULT", payload: snap() };
      if (msg.type === "CTX_EXECUTE") return { type: "CTX_EXECUTE_RESULT", payload: { ok: true, hint: {} } };
      return { ok: false };
    },
  } as unknown as BrowserAdapter;
  return { adapter, calls };
}

function deferredPlanner() {
  let release!: (v: PlannerAction | null) => void;
  const gate = new Promise<PlannerAction | null>((res) => {
    release = res;
  });
  let calls = 0;
  const planner: ActionPlanner = async () => {
    calls++;
    return gate;
  };
  return { planner, release: (v: PlannerAction | null) => release(v), calls: () => calls };
}

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("provider failure taxonomy (never a bare unavailable)", () => {
  const goal = interpretTask("search titanium");

  it("connection-refused health probe is classified and named in the fallback reason", async () => {
    const provider = new GatewayLlmProvider({
      fetchFn: (async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:8000");
      }) as never,
    });
    expect(await provider.available()).toBe(false);
    expect(provider.lastHealthError).toContain("health_network_error");
    expect(provider.lastHealthError).toContain("ECONNREFUSED");

    const seen: Array<{ provider: string; stage: string; error?: string }> = [];
    const planner = buildLlmPlanner(provider);
    const decision = await planner(goal, 0, snap(), { onProviderError: (i) => seen.push(i) });
    expect(decision).not.toBeNull();
    expect(decision!.plan?.source).toBe("local");
    expect(decision!.plan?.fallbackReason).toContain("local task-sourced plan");
    // The cause travels with the fallback — not a bare "unavailable".
    expect(decision!.plan?.fallbackReason).toContain("reasoning gateway unreachable");
    expect(decision!.plan?.fallbackReason).toContain("ECONNREFUSED");
    expect(seen).toHaveLength(1);
    expect(seen[0].stage).toBe("unavailable");
    expect(seen[0].error).toContain("ECONNREFUSED");
  });

  it("health timeout is classified distinctly from a refused connection", async () => {
    const hangingFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("The operation was aborted.");
          err.name = "AbortError";
          reject(err);
        });
      });
    });
    const provider = new GatewayLlmProvider({
      fetchFn: hangingFetch as never,
      healthTimeoutMs: 20,
    });
    expect(await provider.available()).toBe(false);
    expect(provider.lastHealthError).toContain("health_timeout");
  });

  it("non-ok health status is classified with the status code", async () => {
    const provider = new GatewayLlmProvider({
      fetchFn: (async () => new Response(JSON.stringify({ status: "down" }), { status: 503 })) as never,
    });
    expect(await provider.available()).toBe(false);
    expect(provider.lastHealthError).toBe("health_status_503");
  });

  it("an externally aborted request is ABORTED, never a timeout or outage", async () => {
    const provider = new GatewayLlmProvider({ fetchFn: (async () => new Response("{}")) as never });
    const ac = new AbortController();
    ac.abort();
    const res = await provider.complete({}, ac.signal);
    expect(res.ok).toBe(false);
    expect(res.error).toBe("aborted");
    expect(res.errorCode).toBe("ABORTED");
    expect(res.retryable).toBe(false);

    // The planner labels it stage "aborted", not "unavailable".
    const healthy = new GatewayLlmProvider({
      fetchFn: (async (url: string) => {
        if (url.endsWith("/health")) return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
        return new Response(JSON.stringify({ action: { action: "finish", result: "done" } }), { status: 200 });
      }) as never,
    });
    const seen: Array<{ stage: string; error?: string; code?: string }> = [];
    const planner = buildLlmPlanner(healthy);
    // Force the aborted path by stubbing complete() on a live provider.
    healthy.complete = async () => ({ ok: false, error: "aborted", errorCode: "ABORTED", retryable: false });
    const decision = await planner(goal, 0, snap(), { onProviderError: (i) => seen.push(i) });
    expect(decision).not.toBeNull();
    expect(seen).toHaveLength(1);
    expect(seen[0].stage).toBe("aborted");
    expect(decision!.plan?.fallbackReason).toContain("aborted");
    expect(decision!.plan?.fallbackReason).not.toContain("unavailable");
  });

  it("internal budget timeout stays gateway_timeout/TIMEOUT/retryable", async () => {
    const slowFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("The operation was aborted.");
          err.name = "AbortError";
          reject(err);
        });
      });
    });
    const provider = new GatewayLlmProvider({ fetchFn: slowFetch as never, timeoutMs: 30 });
    const res = await provider.complete({});
    expect(res.ok).toBe(false);
    expect(res.error).toBe("gateway_timeout");
    expect(res.errorCode).toBe("TIMEOUT");
    expect(res.retryable).toBe(true);
  });

  it("classifyGatewayError maps every failure class distinctly", () => {
    expect(classifyGatewayError("gateway_error_429: reasoning engine rate-limited")).toEqual({
      errorCode: "RATE_LIMITED",
      retryable: true,
    });
    expect(classifyGatewayError("gateway_error_401: reasoning engine authentication failed")).toEqual({
      errorCode: "AUTH",
      retryable: false,
    });
    expect(classifyGatewayError("gateway_error_503: reasoning engine not configured: GROQ_API_KEY is missing")).toEqual({
      errorCode: "CONFIG",
      retryable: false,
    });
    expect(classifyGatewayError("gateway_error_503: reasoning engine timed out: slow")).toEqual({
      errorCode: "TIMEOUT",
      retryable: true,
    });
    expect(classifyGatewayError("gateway_malformed_json: HTTP 502")).toEqual({
      errorCode: "RESPONSE_PARSE",
      retryable: false,
    });
    expect(classifyGatewayError("gateway_invalid_action: unknown action")).toEqual({
      errorCode: "RESPONSE_PARSE",
      retryable: false,
    });
    expect(classifyGatewayError("gateway_error_500: Groq server error")).toEqual({
      errorCode: "PROVIDER",
      retryable: true,
    });
    expect(classifyGatewayError("gateway_network_error: fetch failed")).toEqual({
      errorCode: "NETWORK",
      retryable: true,
    });
    expect(classifyGatewayError("something entirely new")).toEqual({
      errorCode: "UNKNOWN",
      retryable: false,
    });
  });
});

describe("agent loop terminal-state guards", () => {
  it("stop() while the planner is pending leaves no trace once the late result arrives", async () => {
    const { adapter } = stubBridge();
    const bus = new AgentEventBus();
    const events: string[] = [];
    for (const e of ["PLAN_CHANGED", "ACTION_STARTED", "TASK_COMPLETED", "TASK_FAILED"] as const) {
      bus.on(e, () => events.push(e));
    }
    const gate = deferredPlanner();
    const controller = new AgentController(adapter, bus, gate.planner);
    void controller.run("lifecycle probe task", 7);
    await waitFor(() => gate.calls() > 0);
    controller.stop();
    // The late planner result arrives after the stop.
    gate.release({ action: { action: "navigate", url: "https://example.com" }, justification: "late" });
    await new Promise((r) => setTimeout(r, 150));
    expect(events).toEqual([]);
  });

  it("a superseded run cannot emit terminal events into the task that replaced it", async () => {
    const { adapter } = stubBridge();
    const bus = new AgentEventBus();
    const completed: string[] = [];
    const plans: string[] = [];
    bus.on("TASK_COMPLETED", (p) => completed.push(p.result ?? ""));
    bus.on("TASK_FAILED", (p) => completed.push(`FAILED:${p.reason}`));
    bus.on("PLAN_CHANGED", (p) => plans.push(p.steps.map((s) => s.text).join("|")));

    // One controller (as in production): the first run() parks inside a
    // deferred planner, the second run() supersedes it, then the stale
    // planner resolves late with its own plan + action.
    let release!: (v: PlannerAction | null) => void;
    const gate = new Promise<PlannerAction | null>((res) => {
      release = res;
    });
    let plannerCalls = 0;
    const switchingPlanner: ActionPlanner = async () => {
      plannerCalls++;
      if (plannerCalls === 1) return gate;
      return { action: { action: "finish", result: "run2 done" }, justification: "second" };
    };
    const controller = new AgentController(adapter, bus, switchingPlanner);
    const p1 = controller.run("first task", 7);
    await waitFor(() => plannerCalls > 0);
    await controller.run("second task", 7);
    expect(completed).toEqual(["run2 done"]);

    release({
      action: { action: "navigate", url: "https://example.com" },
      justification: "stale",
      plan: { steps: [{ id: "s1", text: "stale step", status: "pending" }], source: "groq" },
    });
    await p1;
    await new Promise((r) => setTimeout(r, 150));
    expect(completed).toEqual(["run2 done"]);
    expect(plans.some((p) => p.includes("stale step"))).toBe(false);
  });

  it("finish ends the loop: no further bridge traffic after TASK_COMPLETED", async () => {
    const { adapter, calls } = stubBridge();
    const bus = new AgentEventBus();
    let completed = 0;
    bus.on("TASK_COMPLETED", () => completed++);
    const finishPlanner: ActionPlanner = async () => ({
      action: { action: "finish", result: "all done" },
      justification: "t",
    });
    const controller = new AgentController(adapter, bus, finishPlanner);
    await controller.run("lifecycle probe task", 7);
    expect(completed).toBe(1);
    const after = calls.length;
    await new Promise((r) => setTimeout(r, 250));
    expect(calls.length).toBe(after);
    expect(calls).not.toContain("CTX_EXECUTE");
  });
});
