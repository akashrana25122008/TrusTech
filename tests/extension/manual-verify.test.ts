/**
 * Manual objective verification (Phase 17): execution-complete and
 * objective-verified are separate states.
 *
 * Invariants:
 * - TASK_COMPLETED fires without any TASK_VERIFIED (no auto-success).
 * - submitVerification(true/false) resolves to VERIFIED/VERIFY_FAILED.
 * - Verification is accepted only in the awaiting state (guards against
 *   late, duplicate, or out-of-lifecycle calls).
 * - A finish with zero executed actions and no answer parks the task
 *   instead of completing it (PLAN-GENERATED → COMPLETE is dead).
 */
import { describe, it, expect } from "vitest";
import { AgentController } from "@/agent/controller";
import { AgentEventBus } from "@/shared/event-bus";
import type { BrowserAdapter } from "@/browser";
import type { ObservationSnapshot, ActionResult } from "@/shared/messages";
import type { AgentAction } from "@/shared/action-schema";

const HOME = "https://www.youtube.com/";
const RESULTS = "https://www.youtube.com/results?search_query=beginner+C+tutorial";

const el = (id: string, role: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, role, name, tag: "input", visible: true, enabled: true, focused: false,
  rect: { x: 0, y: 0, w: 50, h: 20 }, ...extra,
});

function fakeWorld(opts: { title?: string; url?: string; text?: string } = {}) {
  const state = { url: opts.url ?? HOME, query: "" };
  const snapshot = (): ObservationSnapshot => ({
    url: state.url, title: opts.title ?? "YouTube", tabId: 7, pageType: "content",
    viewport: { w: 1280, h: 800 }, scrollY: 0, scrollH: 2000, loading: false,
    visibleText:
      opts.text ?? (state.url === HOME ? "YouTube Home Search" : `Search results for ${state.query} video one`),
    elements: [
      el("el_010", "searchbox", "Search", { value: state.query }),
      el("el_011", "button", "Search", { tag: "button" }),
      el("el_012", "button", "Attach file", { tag: "button" }),
    ],
    counted: 3,
    createdAt: Date.now(),
  });
  const adapter = {
    runtimeName: "chrome",
    queryActiveTab: async () => ({ id: 7, url: state.url, title: "" }),
    navigateTab: async (_t: number, url: string) => {
      state.url = url;
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
      if (msg.type === "CTX_PING") return { type: "CTX_PONG", payload: { ok: true, url: state.url } };
      if (msg.type === "CTX_OBSERVE") return { type: "CTX_OBSERVE_RESULT", payload: { ...snapshot(), tabId: 7 } };
      if (msg.type === "CTX_EXECUTE") {
        const act = msg.payload?.action as AgentAction;
        // The real executor answers wait/ask_user/finish terminally.
        if (act.action === "wait") {
          return { type: "CTX_EXECUTE_RESULT", payload: { ok: true, hint: {} } satisfies ActionResult };
        }
        if (act.action === "type") {
          state.query = act.text ?? "";
          return { type: "CTX_EXECUTE_RESULT", payload: { ok: true, hint: { value: act.text } } satisfies ActionResult };
        }
        if (act.action === "search") {
          state.query = act.text ?? state.query;
          state.url = RESULTS;
          return { type: "CTX_EXECUTE_RESULT", payload: { ok: true, hint: { value: state.query } } satisfies ActionResult };
        }
        if (act.action === "click") {
          return { type: "CTX_EXECUTE_RESULT", payload: { ok: true, hint: {} } satisfies ActionResult };
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

describe("manual objective verification", () => {
  it("execution completes without any verification verdict (no auto-success)", async () => {
    const { adapter } = fakeWorld();
    const bus = new AgentEventBus();
    const completed: string[] = [];
    const verified: unknown[] = [];
    bus.on("TASK_COMPLETED", (p) => completed.push(p.result ?? ""));
    bus.on("TASK_VERIFIED", (p) => verified.push(p));
    bus.on("USER_INPUT_REQUIRED", () => {});
    const controller = new AgentController(adapter, bus);
    const done = new Promise<void>((resolve) => bus.on("TASK_COMPLETED", () => resolve()));
    await controller.run("Find a beginner C tutorial on YouTube", 7);
    await done;

    expect(completed.length).toBe(1);
    expect(verified).toHaveLength(0);
    expect(controller.status.runtime).toBe("COMPLETED");
  }, 30000);

  it("user confirmation resolves VERIFIED_SUCCESS", async () => {
    const { adapter } = fakeWorld();
    const bus = new AgentEventBus();
    const verdicts: Array<{ ok: boolean }> = [];
    bus.on("TASK_VERIFIED", (p) => verdicts.push({ ok: p.ok }));
    bus.on("USER_INPUT_REQUIRED", () => {});
    const controller = new AgentController(adapter, bus);
    const done = new Promise<void>((resolve) => bus.on("TASK_COMPLETED", () => resolve()));
    await controller.run("Find a beginner C tutorial on YouTube", 7);
    await done;

    controller.submitVerification(true);
    expect(verdicts).toEqual([{ ok: true }]);
    // Duplicate verdicts are ignored — verification cannot be rewritten.
    controller.submitVerification(false);
    expect(verdicts).toEqual([{ ok: true }]);
  }, 30000);

  it("user rejection resolves VERIFIED_FAILED with the reason", async () => {
    const { adapter } = fakeWorld();
    const bus = new AgentEventBus();
    const verdicts: Array<{ ok: boolean; note?: string }> = [];
    bus.on("TASK_VERIFIED", (p) => verdicts.push({ ok: p.ok, note: p.note }));
    bus.on("USER_INPUT_REQUIRED", () => {});
    const controller = new AgentController(adapter, bus);
    const done = new Promise<void>((resolve) => bus.on("TASK_COMPLETED", () => resolve()));
    await controller.run("Find a beginner C tutorial on YouTube", 7);
    await done;

    controller.submitVerification(false, "No video opened.");
    expect(verdicts).toEqual([{ ok: false, note: "No video opened." }]);
  }, 30000);

  it("verification before execution-complete is ignored", async () => {
    const { adapter } = fakeWorld();
    const bus = new AgentEventBus();
    const verdicts: unknown[] = [];
    bus.on("TASK_VERIFIED", (p) => verdicts.push(p));
    const controller = new AgentController(adapter, bus);
    // No run at all: idle controller must not record a verdict.
    controller.submitVerification(true);
    expect(verdicts).toHaveLength(0);
  });

  it("empty finish with zero executions parks instead of completing", async () => {
    const { adapter } = fakeWorld();
    const bus = new AgentEventBus();
    const pauses: string[] = [];
    let completed = false;
    let failed = false;
    bus.on("TASK_PAUSED", (p) => pauses.push(p.reason));
    bus.on("TASK_COMPLETED", () => {
      completed = true;
    });
    bus.on("TASK_FAILED", () => {
      failed = true;
    });
    // A planner that gives up immediately with an empty answer.
    const giveUp = async () => ({
      action: { action: "finish", result: "" } as AgentAction,
      justification: "gave up",
    });
    const controller = new AgentController(adapter, bus, giveUp as never);
    const parked = new Promise<void>((resolve) => bus.on("TASK_PAUSED", () => resolve()));
    const runPromise = controller.run("Find a beginner C tutorial on YouTube", 7);
    await parked;

    expect(pauses[0]).toMatch(/without performing any browser action/i);
    expect(completed).toBe(false);
    expect(failed).toBe(false);
    expect(controller.status.runtime).toBe("PAUSED");
    controller.stop();
    await runPromise;
  }, 30000);

  it("empty finish after placement-only navigation parks (nothing describable)", async () => {
    const { adapter } = fakeWorld();
    const bus = new AgentEventBus();
    const pauses: string[] = [];
    let completed = false;
    bus.on("TASK_PAUSED", (p) => pauses.push(p.reason));
    bus.on("TASK_COMPLETED", () => {
      completed = true;
    });
    // Navigate (verified placement), then an empty give-up finish.
    let calls = 0;
    const planner = async () => {
      calls++;
      if (calls === 1) {
        return {
          action: {
            action: "navigate",
            url: "https://www.youtube.com/results?search_query=x",
            expectedOutcome: { type: "url_change", urlContains: "youtube.com" },
          } as AgentAction,
          justification: "go",
        };
      }
      return { action: { action: "finish", result: "" } as AgentAction, justification: "gave up" };
    };
    const controller = new AgentController(adapter, bus, planner as never);
    bus.on("USER_INPUT_REQUIRED", () => {});
    const parked = new Promise<void>((resolve) => bus.on("TASK_PAUSED", () => resolve()));
    const runPromise = controller.run("Find a beginner C tutorial on YouTube", 7);
    await parked;

    expect(pauses[0]).toMatch(/without an answer to verify/i);
    expect(completed).toBe(false);
    expect(controller.status.runtime).toBe("PAUSED");
    controller.stop();
    await runPromise;
  }, 30000);

  it("pure navigation tasks still complete when the plan is exhausted", async () => {
    const { adapter } = fakeWorld();
    const bus = new AgentEventBus();
    bus.on("USER_INPUT_REQUIRED", () => {});
    let calls = 0;
    const planner = async () => {
      calls++;
      if (calls === 1) {
        return {
          action: {
            action: "navigate",
            url: "https://www.youtube.com/results?search_query=x",
            expectedOutcome: { type: "url_change", urlContains: "youtube.com" },
          } as AgentAction,
          justification: "go",
        };
      }
      return null;
    };
    const controller = new AgentController(adapter, bus, planner as never);
    const done = new Promise<void>((resolve) => bus.on("TASK_COMPLETED", () => resolve()));
    await controller.run("Open YouTube", 7);
    await done;

    expect(controller.status.runtime).toBe("COMPLETED");
  }, 30000);

  it("seed host equal to origin host stays trusted (no permanent UNKNOWN_DOMAIN)", async () => {
    // Verified live: a task starting on its destination host (youtube.com
    // seed == youtube.com origin) scored UNKNOWN_DOMAIN on every page
    // because the origin filter emptied the known-host list.
    const { adapter } = fakeWorld();
    const bus = new AgentEventBus();
    const signals: string[] = [];
    bus.on("TRUST_EVENT", (p) => signals.push(...p.signals));
    bus.on("USER_INPUT_REQUIRED", () => {});
    let calls = 0;
    const planner = async () => {
      calls++;
      return { action: { action: "finish", result: "done" } as AgentAction, justification: "t" };
    };
    const controller = new AgentController(adapter, bus, planner as never);
    const done = new Promise<void>((resolve) => bus.on("TASK_COMPLETED", () => resolve()));
    await controller.run("Find a beginner C tutorial on YouTube", 7);
    await done;

    expect(signals).not.toContain("UNKNOWN_DOMAIN");
    expect(signals).not.toContain("BRAND_DOMAIN_MISMATCH");
  }, 30000);

  it("query words are not brand tokens (results titles echo the query)", async () => {
    const { adapter } = fakeWorld({ title: "beginner C tutorial - YouTube" });
    const bus = new AgentEventBus();
    const decisions: string[] = [];
    bus.on("TRUST_EVENT", (p) => decisions.push(p.decision));
    bus.on("USER_INPUT_REQUIRED", () => {});
    let calls = 0;
    const planner = async () => {
      calls++;
      return { action: { action: "finish", result: "done" } as AgentAction, justification: "t" };
    };
    const controller = new AgentController(adapter, bus, planner as never);
    const done = new Promise<void>((resolve) => bus.on("TASK_COMPLETED", () => resolve()));
    await controller.run("Find a beginner C tutorial on YouTube", 7);
    await done;

    // A results page titled with the query must not read as a brand attack.
    expect(decisions).not.toContain("PAUSE");
    expect(decisions).not.toContain("BLOCK");
  }, 30000);

  it("trust-pause recovery never replays an already-planned step", async () => {
    // Verified live: a trust PAUSE after a verified search decremented the
    // step counter, re-emitting "submit the search" on the results page.
    // Fixture: an identity-upload cue (trust cap 49 → LOW → PAUSE) on an
    // otherwise aligned page — no redirect, no transaction/injection cues,
    // constant fingerprint — so the trust path is isolated from drift.
    const state = { scammy: false, plans: 0 };
    const base = fakeWorld({
      title: "Shoes - Google Search",
      url: "https://www.google.com/search?q=shoes",
      text: "Results for shoes. More items below.",
    });
    const innerSend = (base.adapter as unknown as { sendToTabAndRespond: (t: number, m: unknown) => Promise<unknown> }).sendToTabAndRespond;
    (base.adapter as unknown as { sendToTabAndRespond: (t: number, m: unknown) => Promise<unknown> }).sendToTabAndRespond = async (
      t: number,
      m: unknown,
    ) => {
      const res = (await innerSend(t, m)) as {
        type?: string;
        payload?: Record<string, unknown>;
      };
      if ((m as { type?: string })?.type === "CTX_OBSERVE" && res.payload && !("error" in res.payload)) {
        if (state.scammy) {
          return {
            type: "CTX_OBSERVE_RESULT",
            payload: {
              ...(res.payload as object),
              visibleText: "Results for shoes. Attach your passport document to continue.",
            },
          };
        }
      }
      return res;
    };
    const bus = new AgentEventBus();
    const trustDecisions: string[] = [];
    let pausedSeen = false;
    bus.on("TRUST_EVENT", (p) => {
      trustDecisions.push(p.decision);
      if (p.decision === "PAUSE") {
        pausedSeen = true;
        state.scammy = false;
      }
    });
    const indexesBeforePause: number[] = [];
    const indexesAfterPause: number[] = [];
    const planner = async (_t: unknown, stepIndex: number) => {
      (pausedSeen ? indexesAfterPause : indexesBeforePause).push(stepIndex);
      state.plans++;
      // Go scammy only after two successful plans, for exactly one trust
      // assessment round.
      if (state.plans === 2) state.scammy = true;
      if (state.plans <= 4) {
        return {
          action: { action: "click", target: { elementId: "el_011", name: "Search" }, confidence: 0.95 } as AgentAction,
          justification: "t",
        };
      }
      return { action: { action: "finish", result: "done" } as AgentAction, justification: "t" };
    };
    const controller = new AgentController(base.adapter, bus, planner as never);
    bus.on("USER_INPUT_REQUIRED", () => controller.confirm());
    const terminal = new Promise<void>((resolve) => {
      bus.on("TASK_COMPLETED", () => resolve());
      bus.on("TASK_FAILED", () => resolve());
      bus.on("TASK_PAUSED", () => resolve());
    });
    const runPromise = controller.run("Search shoes", 7);
    await terminal;
    controller.stop();
    await runPromise;

    // The scenario must actually exercise a trust pause (else vacuous).
    expect(trustDecisions).toContain("PAUSE");
    expect(indexesBeforePause.length).toBeGreaterThan(0);
    expect(indexesAfterPause.length).toBeGreaterThan(0);
    // Recovery from a pre-plan trust pause must advance, never replay:
    // the first index planned after the pause is strictly greater than
    // every index planned before it.
    const maxBefore = Math.max(...indexesBeforePause);
    expect(indexesAfterPause[0]).toBeGreaterThan(maxBefore);
  }, 30000);

  it("action lifecycle events carry task, action, and step ids", async () => {
    const { adapter } = fakeWorld();
    const bus = new AgentEventBus();
    const seen: Array<{ taskId?: string; actionId?: string; stepId?: string }> = [];
    const startedIds: Array<string | undefined> = [];
    bus.on("ACTION_STARTED", (p) => {
      seen.push({ taskId: p.taskId, actionId: p.actionId, stepId: p.stepId });
      startedIds.push(p.actionId);
    });
    bus.on("ACTION_SUCCEEDED", (p) => seen.push({ taskId: p.taskId, actionId: p.actionId, stepId: p.stepId }));
    bus.on("VERIFICATION_SUCCEEDED", (p) => seen.push({ taskId: p.taskId, actionId: p.actionId, stepId: p.stepId }));
    bus.on("USER_INPUT_REQUIRED", () => {});
    const controller = new AgentController(adapter, bus);
    const done = new Promise<void>((resolve) => bus.on("TASK_COMPLETED", () => resolve()));
    await controller.run("Find a beginner C tutorial on YouTube", 7);
    await done;

    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) {
      expect(s.taskId).toMatch(/^task_/);
      expect(s.actionId).toMatch(/^act_/);
    }
    // Canonical action ids are unique per executed action.
    expect(new Set(startedIds).size).toBe(startedIds.length);
  }, 30000);
});
