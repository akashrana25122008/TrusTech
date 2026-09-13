import { describe, it, expect } from "vitest";
import { AgentController } from "@/agent/controller";
import { AgentEventBus } from "@/shared/event-bus";
import { assessAction } from "@/agent/risk-manager";
import { resolveTargetContext } from "@/agent/risk-manager";
import { buildVisualPlanner, correlatePointToElement, type VisualPlannerDeps } from "@/agent/visual-planner";
import type { ActionPlanner } from "@/agent/llm-planner";
import type { BrowserAdapter } from "@/browser";
import type { ObservationSnapshot, ActionResult, IndexedElement } from "@/shared/messages";
import type { AgentAction } from "@/shared/action-schema";
import type { TaskGoal } from "@/agent/types";
import type { VisualTransport } from "@/privacy/visual-transmission";

const GOAL = "Click the Submit application button.";

const el = (id: string, role: string, name: string, rect: { x: number; y: number; w: number; h: number }): IndexedElement => ({
  id, role, name, tag: "button", visible: true, enabled: true, focused: false, rect,
});

const snapshot = (): ObservationSnapshot => ({
  url: "https://example.com/form",
  title: "Form",
  tabId: 7,
  pageType: "content",
  viewport: { w: 640, h: 480 },
  scrollY: 0,
  scrollH: 900,
  loading: false,
  visibleText: "Submit application",
  elements: [el("el_1", "button", "Submit application", { x: 300, y: 200, w: 100, h: 40 })],
  counted: 1,
  createdAt: Date.now(),
});

const goal = { goal: GOAL } as TaskGoal;

const VISION_BODY = JSON.stringify({
  actions: [
    {
      type: "click",
      target: {
        bbox: { x: 300, y: 200, width: 100, height: 40 },
        normalized: { x: 0.4688, y: 0.4167, width: 0.1563, height: 0.0833 },
        point: { x: 350, y: 220 },
      },
      confidence: 0.94,
    },
  ],
  reason: "Submit application button",
  completion: false,
  status: "success",
  model: "fake-vlm",
  redacted_regions: 0,
});

function transportReturning(body: string, seen: string[] = []): VisualTransport {
  return {
    async post(_url: string, payload: string) {
      seen.push(payload);
      return { ok: true, status: 200, body };
    },
  };
}

function deps(overrides: Partial<VisualPlannerDeps> = {}): VisualPlannerDeps {
  const adapter = {
    sendToTabAndRespond: async () => ({ type: "CTX_PRIVACY_SCAN_RESULT", payload: { signals: [] } }),
  } as unknown as BrowserAdapter;
  return {
    adapter,
    capture: async () => ({
      raster: { width: 64, height: 48, data: new Uint8ClampedArray(64 * 48 * 4).fill(200) },
      sourceWidth: 640,
      sourceHeight: 480,
      captureMs: 3,
    }),
    infer: async () => ({ detections: [], totalMs: 5, modelId: "yolos-tiny", backend: "cpu" }),
    transport: transportReturning(VISION_BODY),
    baseUrl: "http://localhost:8000",
    allowInsecureLocalhost: true,
    ...overrides,
  };
}

const fallback: ActionPlanner = async () => ({
  action: { action: "finish", result: "fallback done" },
  justification: "fallback",
});

describe("correlatePointToElement", () => {
  it("picks the smallest containing element and skips hidden/disabled ones", () => {
    const snap = snapshot();
    snap.elements.push(el("el_2", "button", "Big", { x: 0, y: 0, w: 640, h: 480 }));
    snap.elements.push({ ...el("el_3", "button", "Hidden", { x: 340, y: 210, w: 10, h: 10 }), visible: false });
    expect(correlatePointToElement(snap, { x: 350, y: 220 })?.id).toBe("el_1");
    expect(correlatePointToElement(snap, { x: 10, y: 10 })?.id).toBe("el_2");
    expect(correlatePointToElement(snapshot(), { x: 5, y: 5 })).toBeNull();
  });
});

describe("buildVisualPlanner", () => {
  it("TEST 1 — normal visual action normalizes to an elementId click", async () => {
    const events: unknown[] = [];
    const planner = buildVisualPlanner(fallback, { ...deps(), onEvent: (e) => events.push(e) });
    const decision = await planner(goal, 0, snapshot());
    expect(decision?.action).toMatchObject({ action: "click", target: { elementId: "el_1" }, confidence: 0.94 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ stage: "grounded", transmitted: true });
  });

  it("TEST 2 — invalid VLM output falls back without a visual action", async () => {
    let fallbackUsed = false;
    const fb: ActionPlanner = async () => {
      fallbackUsed = true;
      return { action: { action: "finish", result: "fb" }, justification: "fb" };
    };
    const planner = buildVisualPlanner(fb, deps({ transport: transportReturning("not json{{") }));
    const decision = await planner(goal, 0, snapshot());
    expect(fallbackUsed).toBe(true);
    expect(decision?.action.action).toBe("finish");
  });

  it("TEST 3 — low confidence is preserved for the existing safety evaluation", async () => {
    const low = VISION_BODY.replace("0.94", "0.2");
    const planner = buildVisualPlanner(fallback, deps({ transport: transportReturning(low) }));
    const decision = await planner(goal, 0, snapshot());
    expect(decision?.action.confidence).toBe(0.2);
    const risk = assessAction(decision!.action, snapshot());
    expect(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).toContain(risk.level);
  });

  it("TEST 4 — visual/DOM mismatch falls back instead of executing a phantom", async () => {
    const far = VISION_BODY.replace('"point":{"x":350,"y":220}', '"point":{"x":5,"y":5}');
    let fallbackUsed = false;
    const fb: ActionPlanner = async () => {
      fallbackUsed = true;
      return { action: { action: "finish", result: "fb" }, justification: "fb" };
    };
    const planner = buildVisualPlanner(fb, deps({ transport: transportReturning(far) }));
    const decision = await planner(goal, 0, snapshot());
    expect(fallbackUsed).toBe(true);
    expect(decision?.action.action).toBe("finish");
  });

  it("TEST 5 — sanitizer plans redaction before transmission", async () => {
    const events: Array<{ stage: string; regions: number; methods: string[]; transmitted: boolean }> = [];
    const adapter = {
      sendToTabAndRespond: async () => ({
        type: "CTX_PRIVACY_SCAN_RESULT",
        payload: {
          viewport: { width: 640, height: 480 },
          signals: [
            { type: "PASSWORD", bbox: { x: 300, y: 200, width: 100, height: 40 }, confidence: 0.96, source: "dom", detector: "d", coordinateSystem: "viewport" },
          ],
          scanned: 1,
          domScanMs: 1,
        },
      }),
    } as unknown as BrowserAdapter;
    const planner = buildVisualPlanner(fallback, {
      ...deps(),
      adapter,
      onEvent: (e) => events.push(e),
    });
    await planner(goal, 0, snapshot());
    expect(events).toHaveLength(1);
    expect(events[0].regions).toBe(1);
    expect(events[0].methods).toEqual(["BLACKOUT"]);
    expect(events[0].transmitted).toBe(true);
  });

  it("TEST 6 — high-risk visual proposal is flagged by the existing risk engine", async () => {
    const risky = snapshot();
    risky.elements = [el("el_9", "button", "Buy now", { x: 300, y: 200, w: 100, h: 40 })];
    const planner = buildVisualPlanner(fallback, deps());
    const decision = await planner(goal, 0, risky);
    expect(decision?.action.target).toEqual({ elementId: "el_9" });
    const grounded = resolveTargetContext(decision!.action, risky);
    expect(grounded.target?.name).toBe("Buy now");
    const risk = assessAction(grounded, risky);
    expect(risk.level).toBe("HIGH");
    expect(risk.requiresConfirmation).toBe(true);
  });

  it("TEST 7/11 — fresh capture per planning call; planner never throws", async () => {
    let captures = 0;
    const d = deps({
      capture: async () => {
        captures++;
        return {
          raster: { width: 64, height: 48, data: new Uint8ClampedArray(64 * 48 * 4) },
          sourceWidth: 640,
          sourceHeight: 480,
          captureMs: 1,
        };
      },
    });
    const planner = buildVisualPlanner(fallback, d);
    await planner(goal, 0, snapshot());
    await planner(goal, 1, snapshot());
    expect(captures).toBe(2);
  });

  it("TEST 10 — transmit failure falls back once per call without throwing", async () => {
    let calls = 0;
    const failing: VisualTransport = {
      async post() {
        calls++;
        throw new Error("network down");
      },
    };
    let fallbackUsed = false;
    const fb: ActionPlanner = async () => {
      fallbackUsed = true;
      return { action: { action: "finish", result: "fb" }, justification: "fb" };
    };
    const planner = buildVisualPlanner(fb, deps({ transport: failing }));
    const decision = await planner(goal, 0, snapshot());
    expect(calls).toBe(1);
    expect(fallbackUsed).toBe(true);
    expect(decision?.action.action).toBe("finish");
  });
});

describe("controller + visual planner integration", () => {
  it("TEST 1/8/9 — visual click flows through risk/trust/execute/verify to completion", async () => {
    const executed: AgentAction[] = [];
    const seenEvents: string[] = [];
    const adapter = {
      runtimeName: "chrome",
      queryActiveTab: async () => ({ id: 7, url: "https://example.com/form", title: "" }),
      navigateTab: async () => undefined,
      reloadTab: async () => undefined,
      closeTab: async () => undefined,
      createTab: async () => null,
      listTabs: async () => [],
      activateTab: async () => undefined,
      goBackTab: async () => false,
      goForwardTab: async () => false,
      sendToTabAndRespond: async (_t: number, message: unknown): Promise<unknown> => {
        const msg = message as { type: string; payload?: { action?: AgentAction } };
        if (msg.type === "CTX_PING") return { type: "CTX_PONG", payload: { ok: true, url: "https://example.com/form" } };
        if (msg.type === "CTX_OBSERVE") return { type: "CTX_OBSERVE_RESULT", payload: { ...snapshot(), tabId: 7 } };
        if (msg.type === "CTX_PRIVACY_SCAN") {
          return { type: "CTX_PRIVACY_SCAN_RESULT", payload: { signals: [], scanned: 0, domScanMs: 0 } };
        }
        if (msg.type === "CTX_EXECUTE") {
          executed.push(msg.payload!.action!);
          return { type: "CTX_EXECUTE_RESULT", payload: { ok: true, hint: { text: "Submitted" } } satisfies ActionResult };
        }
        return { ok: false };
      },
    } as unknown as BrowserAdapter;
    const bus = new AgentEventBus();
    for (const e of ["VISUAL_GROUNDING", "SAFETY_DECIDED", "ACTION_SUCCEEDED", "VERIFICATION_SUCCEEDED"] as const) {
      bus.on(e, () => seenEvents.push(e));
    }
    const outcome = new Promise<string>((resolve) => {
      bus.on("TASK_COMPLETED", (p) => resolve(`COMPLETED: ${(p as { result?: string }).result}`));
      bus.on("TASK_FAILED", (p) => resolve(`FAILED: ${(p as { reason?: string }).reason}`));
    });
    const fb: ActionPlanner = async () => ({ action: { action: "finish", result: "Submitted via visual grounding" }, justification: "fb" });
    let plans = 0;
    const switching: VisualTransport = {
      async post() {
        plans++;
        if (plans === 1) return { ok: true, status: 200, body: VISION_BODY };
        return {
          ok: true,
          status: 200,
          body: JSON.stringify({ actions: [], reason: "done", completion: true, status: "success", model: "", redacted_regions: 0 }),
        };
      },
    };
    const planner = buildVisualPlanner(fb, {
      ...deps(),
      adapter,
      transport: switching,
      onEvent: (event) => bus.emit("VISUAL_GROUNDING", event),
    });
    const controller = new AgentController(adapter, bus, planner);
    bus.on("USER_INPUT_REQUIRED", () => controller.confirm());
    await controller.run(GOAL, 7);
    expect(await outcome).toBe("COMPLETED: Submitted via visual grounding");
    expect(executed.map((a) => a.action)).toContain("click");
    expect(executed.find((a) => a.action === "click")?.target).toMatchObject({ elementId: "el_1" });
    expect(seenEvents).toContain("VISUAL_GROUNDING");
    expect(seenEvents).toContain("SAFETY_DECIDED");
    expect(seenEvents).toContain("ACTION_SUCCEEDED");
    expect(seenEvents).toContain("VERIFICATION_SUCCEEDED");
  }, 30000);
});
