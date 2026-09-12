/**
 * Feature #3 — Confidence-Gated Autonomy.
 * Unit: confidence engine, decision matrix, overrides, target verifier,
 * risk classification. E2E (TEST 1-14): the gate inside the real
 * controller loop. Invariants: critical never auto, approvals bound,
 * blocked never executes, every execution safety-decided.
 */
import { describe, it, expect } from "vitest";
import { AgentController } from "@/agent/controller";
import { AgentEventBus } from "@/shared/event-bus";
import {
  evaluateActionSafety,
  computeConfidence,
  SAFETY_THRESHOLDS,
  type SafetyInput,
} from "@/agent/safety-policy";
import { verifyTarget } from "@/agent/target-verifier";
import { assessAction } from "@/agent/risk-manager";
import type { ActionPlanner } from "@/agent/llm-planner";
import type { PlannerAction } from "@/agent/deterministic-planner";
import type { BrowserAdapter } from "@/browser";
import type { AgentAction } from "@/shared/action-schema";
import type { IndexedElement, ObservationSnapshot } from "@/shared/messages";
import type { RiskLevel } from "@/agent/risk-manager";

const el = (id: string, role: string, name: string, extra: Record<string, unknown> = {}): IndexedElement => ({
  id, role, name, tag: role === "link" ? "a" : "button", visible: true, enabled: true, focused: false,
  rect: { x: 0, y: 0, w: 50, h: 20 }, ...extra,
});

const snap = (over: Partial<ObservationSnapshot> = {}): ObservationSnapshot => ({
  url: "https://example.com/page",
  title: "Example",
  tabId: 7,
  pageType: "content",
  viewport: { w: 1000, h: 800 },
  scrollY: 0,
  scrollH: 0,
  loading: false,
  visibleText: "Welcome to the example page",
  elements: [],
  counted: 0,
  createdAt: Date.now(),
  ...over,
});

/** Scripted planner: decisions in order, then finish. */
function scripted(decisions: Array<PlannerAction | null>): ActionPlanner {
  let i = 0;
  return async () => {
    if (i < decisions.length) return decisions[i++];
    return { action: { action: "finish", result: "script done" }, justification: "end" };
  };
}

const finish = (result = "done"): PlannerAction => ({
  action: { action: "finish", result },
  justification: "t",
});

/** Live stub world with mutable page state + execution recording. */
function stubWorld(init: { url?: string; text?: string; elements?: IndexedElement[] } = {}) {
  const state = {
    url: init.url ?? "https://example.com/page",
    text: init.text ?? "Welcome to the example page",
    elements: init.elements ?? [],
  };
  const executes: string[] = [];
  const observes: string[] = [];
  const snapshot = (): ObservationSnapshot => snap({
    url: state.url,
    visibleText: state.text,
    elements: state.elements,
    counted: state.elements.length,
  });
  const adapter = {
    runtimeName: "chrome",
    queryActiveTab: async () => ({ id: 7, url: state.url, title: "T" }),
    navigateTab: async (_t: number, url: string) => {
      state.url = url;
    },
    sendToTabAndRespond: async (_t: number, message: unknown): Promise<unknown> => {
      const msg = message as { type: string; payload?: { action?: AgentAction } };
      if (msg.type === "CTX_PING") return { type: "CTX_PONG", payload: { ok: true, url: state.url } };
      if (msg.type === "CTX_OBSERVE") {
        observes.push(state.url);
        return { type: "CTX_OBSERVE_RESULT", payload: snapshot() };
      }
      if (msg.type === "CTX_EXECUTE") {
        const act = msg.payload?.action as AgentAction;
        executes.push(`${act.action}:${act.target?.elementId ?? act.target?.name ?? ""}`);
        if (act.action === "type" && act.target?.elementId) {
          state.text = `${state.text} [typed]`;
        }
        return { type: "CTX_EXECUTE_RESULT", payload: { ok: true, hint: {} } };
      }
      return { ok: false };
    },
  } as unknown as BrowserAdapter;
  return { adapter, state, executes, observes };
}

async function runTask(
  world: ReturnType<typeof stubWorld>,
  goal: string,
  planner: ActionPlanner,
  hooks: { onAsk?: (p: { actionId?: string }, c: AgentController) => void } = {},
) {
  const bus = new AgentEventBus();
  const events: string[] = [];
  const safety: Array<{ actionId: string; decision: string }> = [];
  const asks: Array<{ actionId?: string }> = [];
  for (const e of ["SAFETY_DECIDED", "ACTION_STARTED", "TASK_COMPLETED", "TASK_FAILED", "RECOVERY_ATTEMPT", "VERIFICATION_FAILED", "APPROVAL_INVALIDATED", "USER_INPUT_REQUIRED"] as const) {
    bus.on(e, (p) => {
      events.push(e);
      if (e === "SAFETY_DECIDED") safety.push({ actionId: (p as { actionId: string }).actionId, decision: (p as { decision: string }).decision });
      if (e === "USER_INPUT_REQUIRED") {
        asks.push({ actionId: (p as { actionId?: string }).actionId });
        hooks.onAsk?.(p as { actionId?: string }, controller);
      }
    });
  }
  const controller = new AgentController(world.adapter, bus, planner);
  await controller.run(goal, 7);
  return { events, safety, asks, executes: world.executes, controller };
}

/* ---------------- A. confidence engine ---------------- */

describe("confidence engine", () => {
  const verifiedTarget = { status: "verified" as const, confidence: 0.95, matches: 1, reason: "ok" };
  const click = { action: "click" as const, target: { elementId: "el_001" } };

  it("strong agreement lands HIGH (>= 0.85)", () => {
    const c = computeConfidence(0.97, verifiedTarget, true, true, "Search tutorials", {
      ...click, target: { elementId: "el_001", name: "Search" },
    });
    expect(c.band).toBe("HIGH");
    expect(c.final).toBeGreaterThanOrEqual(SAFETY_THRESHOLDS.high);
  });

  it("missing/invalid model confidence is discounted, not fatal", () => {
    for (const bad of [undefined, NaN, Infinity]) {
      const c = computeConfidence(bad as number | undefined, verifiedTarget, true, true, "Search tutorials", click);
      expect(c.components.model).toBe(0.4);
      expect(c.reason).toContain("discounted");
    }
  });

  it("stale context drags the score down", () => {
    const fresh = computeConfidence(0.9, verifiedTarget, true, true, "g", click);
    const staleTarget = { status: "stale" as const, confidence: 0.2, matches: 0, reason: "moved" };
    const stale = computeConfidence(0.9, staleTarget, false, true, "g", click);
    expect(stale.final).toBeLessThan(fresh.final);
    expect(stale.band).not.toBe("HIGH");
  });

  it("thresholds are centralized and testable", () => {
    expect(SAFETY_THRESHOLDS.high).toBe(0.85);
    expect(SAFETY_THRESHOLDS.medium).toBe(0.6);
  });
});

/* ---------------- B/C. matrix + overrides ---------------- */

function matrixInput(proposed: number, risk: RiskLevel, contextFresh = true): SafetyInput {
  return {
    canonical: {
      actionId: "act_test",
      taskId: "task_test",
      action: { action: "click", target: { elementId: "el_001", name: "Search" } },
      proposedConfidence: proposed,
      // Neutral goal: no token overlap, so the band comes from the
      // model/context signals under test, not intent leakage.
      goal: "do the thing",
      plannedUrl: "https://example.com/page",
    },
    risk,
    riskRequiresConfirmation: risk === "HIGH" || risk === "CRITICAL",
    target: { status: "verified", confidence: 0.95, matches: 1, reason: "ok" },
    validityOk: true,
    contextFresh,
    verifiable: true,
  };
}

describe("decision matrix (confidence × risk)", () => {
  it.each([
    [0.95, "LOW", "AUTO_EXECUTE"],
    [0.95, "MEDIUM", "LOCAL_VERIFY"],
    [0.95, "HIGH", "USER_CONFIRMATION_REQUIRED"],
    [0.95, "CRITICAL", "USER_CONFIRMATION_REQUIRED"],
    [0.7, "LOW", "LOCAL_VERIFY"],
    [0.7, "MEDIUM", "LOCAL_VERIFY"],
    [0.7, "HIGH", "USER_CONFIRMATION_REQUIRED"],
    [0.7, "CRITICAL", "USER_CONFIRMATION_REQUIRED"],
  ] as Array<[number, RiskLevel, string]>)("model %s + %s → %s", (conf, risk, decision) => {
    expect(evaluateActionSafety(matrixInput(conf, risk)).decision).toBe(decision);
  });

  it("LOW band: LOW→VERIFY, MEDIUM→CONFIRM, HIGH/CRITICAL→BLOCK", () => {
    // Weak model score + changed context → LOW band.
    expect(evaluateActionSafety(matrixInput(0.2, "LOW", false)).decision).toBe("LOCAL_VERIFY");
    expect(evaluateActionSafety(matrixInput(0.2, "MEDIUM", false)).decision).toBe("USER_CONFIRMATION_REQUIRED");
    expect(evaluateActionSafety(matrixInput(0.2, "HIGH", false)).decision).toBe("BLOCK");
    expect(evaluateActionSafety(matrixInput(0.2, "CRITICAL", false)).decision).toBe("BLOCK");
  });

  it("hard overrides ignore model confidence", () => {
    const base = matrixInput(0.99, "LOW");
    const missing = { ...base, target: { status: "missing" as const, confidence: 0, matches: 0, reason: "gone" } };
    expect(evaluateActionSafety(missing).decision).toBe("BLOCK");
    const stale = { ...base, target: { status: "stale" as const, confidence: 0.2, matches: 0, reason: "moved" }, contextFresh: false };
    expect(evaluateActionSafety(stale).decision).toBe("REPLAN");
    const hidden = { ...base, target: { status: "hidden" as const, confidence: 0.25, matches: 1, reason: "hidden" } };
    expect(evaluateActionSafety(hidden).decision).toBe("REPLAN");
    const ambiguousLow = {
      ...base, target: { status: "ambiguous" as const, confidence: 0.4, matches: 3, reason: "3 match" },
    };
    expect(evaluateActionSafety(ambiguousLow).decision).toBe("LOCAL_VERIFY");
    const ambiguousHigh = { ...ambiguousLow, risk: "HIGH" as RiskLevel, riskRequiresConfirmation: true };
    expect(evaluateActionSafety(ambiguousHigh).decision).toBe("USER_CONFIRMATION_REQUIRED");
  });

  it("unverifiable pages: browser actions proceed, missing targets replan", () => {
    const nav = {
      ...matrixInput(0.7, "LOW"),
      canonical: {
        ...matrixInput(0.7, "LOW").canonical,
        action: { action: "navigate" as const, url: "https://example.com" },
      },
      verifiable: false,
    };
    // MEDIUM × LOW would VERIFY — vacuous without a DOM bridge, so AUTO.
    expect(evaluateActionSafety(nav).decision).toBe("AUTO_EXECUTE");
    const missingUnverifiable = {
      ...matrixInput(0.9, "LOW"),
      target: { status: "missing" as const, confidence: 0, matches: 0, reason: "no bridge" },
      verifiable: false,
    };
    expect(evaluateActionSafety(missingUnverifiable).decision).toBe("REPLAN");
  });

  it("invariants: CRITICAL never auto/verifies; AUTO only for LOW risk", () => {
    const bands: Array<[number, boolean]> = [[0.99, true], [0.7, true], [0.2, false]];
    const risks: RiskLevel[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
    for (const [conf, fresh] of bands) {
      for (const risk of risks) {
        const d = evaluateActionSafety(matrixInput(conf, risk, fresh)).decision;
        // Per matrix: HIGH band CRITICAL→CONFIRM; LOW band CRITICAL→BLOCK.
        if (risk === "CRITICAL") expect(["USER_CONFIRMATION_REQUIRED", "BLOCK"]).toContain(d);
        if (d === "AUTO_EXECUTE") expect(risk).toBe("LOW");
        if (d === "BLOCK") expect(["HIGH", "CRITICAL"]).toContain(risk);
      }
    }
  });
});

/* ---------------- D. target verifier ---------------- */

describe("target verifier", () => {
  const s = () => snap({ elements: [el("el_001", "button", "Submit order"), el("el_002", "link", "Docs")] });

  it("verifies a live target with agreeing label", () => {
    const v = verifyTarget({ action: "click", target: { elementId: "el_001", name: "Submit" } }, s());
    expect(v.status).toBe("verified");
    expect(v.confidence).toBeGreaterThan(0.9);
  });

  it("reports missing / hidden / disabled distinctly", () => {
    expect(verifyTarget({ action: "click", target: { elementId: "el_999" } }, s()).status).toBe("missing");
    expect(verifyTarget({ action: "click", target: { elementId: "el_001" } }, snap({ elements: [el("el_001", "button", "Submit", { visible: false })] })).status).toBe("hidden");
    expect(verifyTarget({ action: "click", target: { elementId: "el_001" } }, snap({ elements: [el("el_001", "button", "Submit", { enabled: false })] })).status).toBe("disabled");
  });

  it("flags label mismatch when the element changed meaning", () => {
    const v = verifyTarget({ action: "click", target: { elementId: "el_001", name: "Delete everything" } }, s());
    expect(v.status).toBe("label_mismatch");
  });

  it("flags ambiguity with a match count, never picks", () => {
    const multi = snap({ elements: [el("el_001", "button", "Submit"), el("el_002", "button", "Submit form"), el("el_003", "button", "Submit all")] });
    const v = verifyTarget({ action: "click", target: { role: "button", name: "Submit" } }, multi);
    expect(v.status).toBe("ambiguous");
    expect(v.matches).toBe(3);
  });

  it("flags stale pages via the tab-URL anchor", () => {
    const v = verifyTarget({ action: "click", target: { elementId: "el_001" } }, s(), { tabUrl: "https://example.com/other" });
    expect(v.status).toBe("stale");
  });

  it("needs no element for viewport-level or non-page actions", () => {
    expect(verifyTarget({ action: "scroll" }, s()).status).toBe("verified");
    expect(verifyTarget({ action: "navigate", url: "https://example.com" }, s()).status).toBe("verified");
    expect(verifyTarget({ action: "finish", result: "done" }, s()).status).toBe("verified");
  });
});

/* ---------------- risk classification (agent engine) ---------------- */

describe("risk engine (consequence classification)", () => {
  it("CRITICAL for account deletion even at 0.99 model confidence", () => {
    const r = assessAction({ action: "click", target: { elementId: "el_1", name: "Delete my account" }, confidence: 0.99 });
    expect(r.level).toBe("CRITICAL");
    expect(r.requiresConfirmation).toBe(true);
  });

  it("HIGH for payments, uploads and typed PII", () => {
    expect(assessAction({ action: "click", target: { elementId: "el_1", name: "Pay now" } }).level).toBe("HIGH");
    expect(assessAction({ action: "click", target: { elementId: "el_1", name: "Upload document" } }).level).toBe("HIGH");
    const typed = assessAction({ action: "type", target: { elementId: "el_1", name: "Notes" }, text: "mail me at a@b.com" });
    expect(typed.level).toBe("HIGH");
    expect(typed.requiresConfirmation).toBe(true);
  });

  it("MEDIUM for submit, LOW for routine browsing", () => {
    const submit = assessAction({ action: "submit", target: { elementId: "el_1", name: "Send" } });
    expect(submit.level).toBe("MEDIUM");
    expect(submit.requiresConfirmation).toBe(false);
    expect(assessAction({ action: "navigate", url: "https://example.com" }).level).toBe("LOW");
  });
});

/* ---------------- E2E TEST 1–14 in the real loop ---------------- */

describe("E2E safety gate (TEST 1–14)", () => {
  it("TEST 1: search button 97% LOW → AUTO executes, no approval", async () => {
    const world = stubWorld({ elements: [el("el_010", "searchbox", "Search")] });
    const r = await runTask(world, "Search tutorials", scripted([
      { action: { action: "click", target: { elementId: "el_010", name: "Search" }, confidence: 0.97 }, justification: "t" },
      finish(),
    ]));
    expect(r.executes).toContain("click:el_010");
    expect(r.asks).toHaveLength(0);
    expect(r.events).toContain("TASK_COMPLETED");
  }, 30000);

  it("TEST 2: scroll 92% LOW → AUTO executes", async () => {
    const world = stubWorld({});
    const r = await runTask(world, "Scroll down the page", scripted([
      { action: { action: "scroll", confidence: 0.92 }, justification: "t" },
      finish(),
    ]));
    expect(r.executes.some((e) => e.startsWith("scroll"))).toBe(true);
    expect(r.asks).toHaveLength(0);
  }, 30000);

  it("TEST 3: ambiguous button 72% → VERIFY then REPLAN, never blind-picks", async () => {
    const world = stubWorld({
      elements: [el("el_001", "button", "Submit"), el("el_002", "button", "Submit form"), el("el_003", "button", "Submit all")],
    });
    const r = await runTask(world, "Submit the form", scripted([
      { action: { action: "click", target: { role: "button", name: "Submit" }, confidence: 0.72 }, justification: "t" },
      finish(),
    ]));
    expect(r.executes.filter((e) => e.startsWith("click"))).toHaveLength(0);
    expect(r.events).toContain("RECOVERY_ATTEMPT");
    expect(r.events).toContain("TASK_COMPLETED");
  }, 30000);

  it("TEST 4: unknown target 55% → BLOCK, task fails honestly", async () => {
    const world = stubWorld({ elements: [el("el_001", "button", "Docs")] });
    const r = await runTask(world, "Press the mystery button", scripted([
      { action: { action: "click", target: { role: "button", name: "Nonexistent Xyzzy" }, confidence: 0.55 }, justification: "t" },
    ]));
    expect(r.executes).toHaveLength(0);
    expect(r.events).toContain("TASK_FAILED");
    expect(r.safety[0].decision).toBe("BLOCK");
  }, 30000);

  it("TEST 5: submit 95% HIGH → USER CONFIRMATION then executes once", async () => {
    const world = stubWorld({ elements: [el("el_pay", "button", "Pay now")] });
    const r = await runTask(world, "Pay for the order", scripted([
      {
        action: { action: "submit", target: { elementId: "el_pay", name: "Pay now" }, confidence: 0.95, expectedOutcome: { type: "noop" } },
        justification: "t",
      },
      finish(),
    ]), {
      onAsk: (p, c) => {
        expect(p.actionId).toMatch(/^act_/);
        c.confirm(p.actionId);
      },
    });
    expect(r.asks).toHaveLength(1);
    expect(r.executes.filter((e) => e === "submit:el_pay")).toHaveLength(1);
    expect(r.events).toContain("TASK_COMPLETED");
  }, 30000);

  it("TEST 6: upload document → USER CONFIRMATION", async () => {
    const world = stubWorld({ elements: [el("el_up", "button", "Upload document")] });
    const r = await runTask(world, "Upload the document", scripted([
      {
        action: { action: "click", target: { elementId: "el_up", name: "Upload document" }, confidence: 0.9, expectedOutcome: { type: "noop" } },
        justification: "t",
      },
      finish(),
    ]), { onAsk: (p, c) => c.confirm(p.actionId) });
    expect(r.asks).toHaveLength(1);
    expect(r.executes).toContain("click:el_up");
  }, 30000);

  it("TEST 7: delete account 99% CRITICAL → explicit confirmation still required", async () => {
    const world = stubWorld({ elements: [el("el_del", "button", "Delete my account")] });
    const r = await runTask(world, "Delete my account", scripted([
      {
        action: { action: "click", target: { elementId: "el_del", name: "Delete my account" }, confidence: 0.99, expectedOutcome: { type: "noop" } },
        justification: "t",
      },
      finish(),
    ]), { onAsk: (p, c) => c.confirm(p.actionId) });
    expect(r.asks).toHaveLength(1);
    expect(r.safety.find((s) => s.decision === "USER_CONFIRMATION_REQUIRED")).toBeDefined();
    expect(r.executes).toContain("click:el_del");
  }, 30000);

  it("TEST 8: payment 98% CRITICAL → explicit confirmation", async () => {
    const world = stubWorld({ elements: [el("el_pay", "button", "Pay now")] });
    const r = await runTask(world, "Pay the invoice", scripted([
      {
        action: { action: "click", target: { elementId: "el_pay", name: "Pay now" }, confidence: 0.98, expectedOutcome: { type: "noop" } },
        justification: "t",
      },
      finish(),
    ]), { onAsk: (p, c) => c.confirm(p.actionId) });
    expect(r.asks).toHaveLength(1);
    expect(r.executes).toContain("click:el_pay");
    expect(r.events).toContain("TASK_COMPLETED");
  }, 30000);

  it("TEST 9: stale page → REPLAN until retries exhaust, then honest failure", async () => {
    const world = stubWorld({ elements: [el("el_001", "button", "Go")] });
    // Tab query always disagrees with the snapshot → every plan is stale.
    world.adapter.queryActiveTab = async () => ({ id: 7, url: "https://example.com/elsewhere", title: "T" });
    const staleClick = (): PlannerAction => ({
      action: { action: "click", target: { elementId: "el_001" }, confidence: 0.9 },
      justification: "t",
    });
    const r = await runTask(world, "Press go", scripted([staleClick(), staleClick(), staleClick(), staleClick()]));
    expect(r.executes).toHaveLength(0);
    expect(r.events.filter((e) => e === "RECOVERY_ATTEMPT").length).toBeGreaterThan(0);
    expect(r.events).toContain("TASK_FAILED");
  }, 30000);

  it("TEST 10: expected result mismatch → STOP + REPLAN path", async () => {
    const world = stubWorld({ elements: [el("el_001", "link", "Next")] });
    const r = await runTask(world, "Go to results", scripted([
      {
        action: { action: "click", target: { elementId: "el_001" }, confidence: 0.9, expectedOutcome: { type: "url_change", urlContains: "done" } },
        justification: "t",
      },
      finish("replanned finish"),
    ]));
    expect(r.events).toContain("VERIFICATION_FAILED");
    expect(r.events).toContain("RECOVERY_ATTEMPT");
    expect(r.events).toContain("TASK_COMPLETED");
  }, 30000);

  it("TEST 11: multiple matching targets → VERIFY, no arbitrary pick", async () => {
    const world = stubWorld({
      elements: [el("el_001", "button", "Submit"), el("el_002", "button", "Submit")],
    });
    const r = await runTask(world, "Submit", scripted([
      { action: { action: "click", target: { role: "button", name: "Submit" }, confidence: 0.88 }, justification: "t" },
      finish(),
    ]));
    expect(r.executes.filter((e) => e.startsWith("click"))).toHaveLength(0);
    expect(r.events).toContain("TASK_COMPLETED");
  }, 30000);

  it("TEST 12: page changes after approval → approval invalidated, reverify", async () => {
    const world = stubWorld({ elements: [el("el_pay", "button", "Pay now")] });
    const r = await runTask(world, "Pay the invoice", scripted([
      {
        action: { action: "click", target: { elementId: "el_pay", name: "Pay now" }, confidence: 0.95, expectedOutcome: { type: "noop" } },
        justification: "t",
      },
      finish(),
    ]), {
      onAsk: (p, c) => {
        // Navigate away before approving: the approval must die.
        world.state.url = "https://example.com/changed";
        c.confirm(p.actionId);
      },
    });
    expect(r.events).toContain("APPROVAL_INVALIDATED");
    expect(r.executes.filter((e) => e === "click:el_pay")).toHaveLength(0);
    expect(r.events).toContain("TASK_COMPLETED");
  }, 30000);

  it("TEST 13: duplicate approval executes at most once", async () => {
    const world = stubWorld({ elements: [el("el_pay", "button", "Pay now")] });
    const r = await runTask(world, "Pay the invoice", scripted([
      {
        action: { action: "click", target: { elementId: "el_pay", name: "Pay now" }, confidence: 0.95, expectedOutcome: { type: "noop" } },
        justification: "t",
      },
      finish(),
    ]), {
      onAsk: (p, c) => {
        c.confirm(p.actionId);
        c.confirm(p.actionId); // duplicate — must be a no-op
      },
    });
    expect(r.executes.filter((e) => e === "click:el_pay")).toHaveLength(1);
  }, 30000);

  it("TEST 14: unapproved HIGH action never executes (no bypass)", async () => {
    const world = stubWorld({ elements: [el("el_pay", "button", "Pay now")] });
    const bus = new AgentEventBus();
    const controller = new AgentController(
      world.adapter,
      bus,
      scripted([
        { action: { action: "click", target: { elementId: "el_pay", name: "Pay now" }, confidence: 0.95 }, justification: "t" },
        finish(),
      ]),
    );
    let asked = 0;
    bus.on("USER_INPUT_REQUIRED", () => {
      asked++;
      void controller.stop(); // user walks away instead of approving
    });
    await controller.run("Pay the invoice", 7);
    expect(asked).toBe(1);
    expect(world.executes.filter((e) => e === "click:el_pay")).toHaveLength(0);
  }, 30000);

  it("wrong-id approval is ignored; correct approval proceeds", async () => {
    const world = stubWorld({ elements: [el("el_pay", "button", "Pay now")] });
    const r = await runTask(world, "Pay the invoice", scripted([
      {
        action: { action: "click", target: { elementId: "el_pay", name: "Pay now" }, confidence: 0.95, expectedOutcome: { type: "noop" } },
        justification: "t",
      },
      finish(),
    ]), {
      onAsk: (p, c) => {
        c.confirm("act_forged_id");
        setTimeout(() => c.confirm(p.actionId), 20);
      },
    });
    expect(r.executes.filter((e) => e === "click:el_pay")).toHaveLength(1);
  }, 30000);

  it("denied confirmation returns to observing without executing", async () => {
    const world = stubWorld({ elements: [el("el_pay", "button", "Pay now")] });
    const r = await runTask(world, "Pay the invoice", scripted([
      {
        action: { action: "click", target: { elementId: "el_pay", name: "Pay now" }, confidence: 0.95, expectedOutcome: { type: "noop" } },
        justification: "t",
      },
      finish(),
    ]), { onAsk: (_p, c) => c.deny() });
    expect(r.executes.filter((e) => e === "click:el_pay")).toHaveLength(0);
    expect(r.events).toContain("TASK_COMPLETED");
  }, 30000);
});

/* ---------------- performance (lightweight gate) ---------------- */

describe("safety gate performance", () => {
  it("evaluates + verifies in microseconds-scale budgets (pure local code)", () => {
    const s = snap({ elements: [el("el_001", "button", "Submit order")] });
    const action = { action: "click" as const, target: { elementId: "el_001", name: "Submit" }, confidence: 0.9 };
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) {
      const target = verifyTarget(action, s);
      evaluateActionSafety({
        canonical: { actionId: `act_${i}`, taskId: "t", action, proposedConfidence: 0.9, goal: "Submit order", plannedUrl: s.url },
        risk: "MEDIUM",
        riskRequiresConfirmation: false,
        target,
        validityOk: true,
        contextFresh: true,
        verifiable: true,
      });
    }
    const avg = (performance.now() - t0) / 200;
    // Generous bound for shared CI runners; typical is <0.5ms.
    expect(avg).toBeLessThan(10);
  });
});

/* ---------------- invariants ---------------- */

describe("safety invariants", () => {
  it("every executed action was safety-decided, with unique action ids", async () => {
    const world = stubWorld({ elements: [el("el_010", "searchbox", "Search")] });
    const r = await runTask(world, "Search tutorials", scripted([
      { action: { action: "click", target: { elementId: "el_010", name: "Search" }, confidence: 0.97 }, justification: "t" },
      finish(),
    ]));
    const ids = r.safety.map((s) => s.actionId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(r.executes.length);
    expect(r.safety.every((s) => s.decision !== "BLOCK")).toBe(true);
  }, 30000);
});
