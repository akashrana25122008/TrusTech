import { describe, it, expect } from "vitest";
import { StateManager } from "@/agent/state-manager";
import { RecoveryManager } from "@/agent/recovery-manager";
import { validateAction } from "@/agent/action-validator";
import { assessAction } from "@/agent/risk-manager";
import { checkCompletion } from "@/agent/completion-detector";
import { verifyAction } from "@/agent/verifier";
import { interpretTask } from "@/agent/task-interpreter";
import type { ObservationSnapshot } from "@/shared/messages";

function snapshot(over: Partial<ObservationSnapshot> = {}): ObservationSnapshot {
  return {
    url: "https://example.com",
    title: "t",
    tabId: 1,
    pageType: "content",
    viewport: { w: 1000, h: 800 },
    scrollY: 0,
    scrollH: 0,
    loading: false,
    visibleText: "Welcome back! your@email.com",
    elements: [
      { id: "el_001", role: "textbox", name: "Search", tag: "input", visible: true, enabled: true, focused: false, rect: { x: 0, y: 0, w: 50, h: 20 } },
    ],
    counted: 1,
    createdAt: Date.now(),
    ...over,
  };
}

describe("StateManager", () => {
  it("follows explicit transitions only", () => {
    const sm = new StateManager();
    expect(sm.transition("ACTING")).toBe(false);
    expect(sm.transition("UNDERSTANDING")).toBe(true);
    expect(sm.transition("OBSERVING")).toBe(true);
    expect(sm.transition("PLANNING")).toBe(true);
    expect(sm.transition("VALIDATING")).toBe(true);
    expect(sm.transition("ACTING")).toBe(true);
  });

  it("maps runtime status to UI key", () => {
    const sm = new StateManager();
    sm.transition("UNDERSTANDING");
    expect(sm.ui).toBe("THINKING");
    sm.transition("OBSERVING");
    expect(sm.ui).toBe("OBSERVING");
    sm.transition("PLANNING");
    sm.transition("VALIDATING");
    sm.transition("ACTING");
    sm.transition("VERIFYING");
    sm.transition("COMPLETED");
    expect(sm.ui).toBe("SUCCESS");
    expect(sm.isTerminal()).toBe(true);
  });
});

describe("RecoveryManager", () => {
  it("bounded retries then gives up", () => {
    const rm = new RecoveryManager(2);
    expect(rm.plan("stale element").kind).toBe("reobserve_then_retry");
    expect(rm.plan("stale element").kind).toBe("reobserve_then_retry");
    expect(rm.plan("stale element").kind).toBe("give_up");
    expect(rm.exhausted).toBe(true);
    rm.reset();
    expect(rm.exhausted).toBe(false);
  });
});

describe("action-validator", () => {
  it("rejects actions on elements missing from the observation", () => {
    const r = validateAction({ action: "click", target: { elementId: "el_999" } }, snapshot());
    expect(r.ok).toBe(false);
  });

  it("rejects actions on disabled or hidden elements", () => {
    const hidden = validateAction(
      { action: "click", target: { elementId: "el_001" } },
      snapshot({ elements: [{ ...snapshot().elements[0], visible: false }] }),
    );
    expect(hidden.ok).toBe(false);
    const disabled = validateAction(
      { action: "click", target: { elementId: "el_001" } },
      snapshot({ elements: [{ ...snapshot().elements[0], enabled: false }] }),
    );
    expect(disabled.ok).toBe(false);
  });

  it("allows navigation actions without a target", () => {
    expect(validateAction({ action: "navigate", url: "https://x.io" }, snapshot()).ok).toBe(true);
  });
});

describe("risk-manager", () => {
  it("flags credential-looking typed input as high risk", () => {
    const r = assessAction({ action: "type", target: { elementId: "el_001" }, text: "my1234@bank" }, snapshot());
    expect(r.level).toBe("HIGH");
    expect(r.requiresConfirmation).toBe(true);
  });

  it("low for benign finishes", () => {
    const r = assessAction({ action: "finish", result: "done" }, snapshot());
    expect(r.level).toBe("LOW");
  });

  it("treats ordinary navigation as LOW with no confirmation (external URL is not risk)", () => {
    for (const action of [
      { action: "navigate", url: "https://www.youtube.com" },
      { action: "navigate", url: "https://www.google.com/search?q=c+language+tutorial" },
      { action: "new_tab", url: "https://www.youtube.com" },
      { action: "switch_tab" },
      { action: "reload" },
      { action: "back" },
      { action: "forward" },
    ] as const) {
      const r = assessAction(action, snapshot());
      expect(r.level).toBe("LOW");
      expect(r.requiresConfirmation).toBe(false);
    }
  });

  it("treats routine search interactions as LOW", () => {
    const clickSearch = assessAction(
      { action: "click", target: { elementId: "el_002", name: "Search" } },
      snapshot(),
    );
    expect(clickSearch.level).toBe("LOW");
    expect(clickSearch.requiresConfirmation).toBe(false);

    const typeQuery = assessAction(
      { action: "type", target: { elementId: "el_001", name: "Search" }, text: "C language tutorial" },
      snapshot(),
    );
    expect(typeQuery.level).toBe("LOW");
    expect(typeQuery.requiresConfirmation).toBe(false);
  });

  it("treats form submission and tab close as MEDIUM without gating", () => {
    const submit = assessAction({ action: "submit", target: { elementId: "el_002" } }, snapshot());
    expect(submit.level).toBe("MEDIUM");
    expect(submit.requiresConfirmation).toBe(false);

    const close = assessAction({ action: "close_tab" }, snapshot());
    expect(close.level).toBe("MEDIUM");
    expect(close.requiresConfirmation).toBe(false);
  });

  it("gates final payment, account deletion, and money transfer", () => {    const pay = assessAction(
      { action: "click", target: { elementId: "el_002", name: "Pay now" } },
      snapshot(),
    );
    expect(pay.level).toBe("HIGH");
    expect(pay.requiresConfirmation).toBe(true);

    const del = assessAction(
      { action: "click", target: { elementId: "el_002", name: "Delete my account" } },
      snapshot(),
    );
    expect(["HIGH", "CRITICAL"]).toContain(del.level);
    expect(del.requiresConfirmation).toBe(true);

    const transfer = assessAction(
      { action: "click", target: { elementId: "el_002", name: "Transfer money" } },
      snapshot(),
    );
    expect(transfer.level).toBe("HIGH");
    expect(transfer.requiresConfirmation).toBe(true);
  });

  it("model confidence never overrides the local risk decision", () => {
    // A model 99% sure about a payment click is still gated: confidence is
    // advisory, risk is authoritative.
    const r = assessAction(
      { action: "click", target: { elementId: "el_002", name: "Pay now" }, confidence: 0.99 },
      snapshot(),
    );
    expect(r.level).toBe("HIGH");
    expect(r.requiresConfirmation).toBe(true);
  });
});

describe("completion-detector", () => {
  it("finishes on explicit finish action in memory", () => {
    const task = interpretTask("search youtube tutorial");
    const c = checkCompletion(task, snapshot(), [
      { kind: "planned", action: { action: "finish", result: "ts" }, ts: 1 },
      { kind: "executed", action: { action: "finish" }, ok: true, ts: 2 },
    ]);
    expect(c.done).toBe(true);
  });

  it("not done early", () => {
    const task = interpretTask("search youtube tutorial");
    const c = checkCompletion(task, snapshot(), []);
    expect(c.done).toBe(false);
  });

  it("navigation alone is not task completion, even with keyword overlap", () => {
    const task = interpretTask("Open YouTube and find a beginner C language tutorial.");
    const home = snapshot({
      url: "https://www.youtube.com/",
      visibleText:
        "YouTube Home Search Shorts Subscriptions C Language Tutorial for Beginners " +
        "Tips and Tricks Open Source Projects About Press Copyright",
    });
    const mem = [
      { kind: "observation", snapshot: snapshot({ url: "chrome://newtab/", visibleText: "" }), ts: 1 },
      { kind: "executed", action: { action: "navigate", url: "https://www.youtube.com/" }, ok: true, ts: 2 },
      { kind: "observation", snapshot: home, ts: 3 },
    ] as never[];
    // 6 goal tokens match the homepage, yet only a navigate ran: not done.
    expect(checkCompletion(task, home, mem).done).toBe(false);
  });
});

describe("verifier", () => {
  it("passes URL-change expectation as evidence", async () => {
    const pre = snapshot({ url: "https://a.com" });
    const v = await verifyAction(
      { action: "click", target: { elementId: "el_001" }, expectedOutcome: { type: "url_change" } },
      {},
      pre,
      () => snapshot({ url: "https://b.com" }),
    );
    expect(v.ok).toBe(true);
    expect(v.evidence.some((e) => e.includes("URL changed"))).toBe(true);
  });

  it("fails when expected URL change does not happen", async () => {
    const pre = snapshot({ url: "https://a.com" });
    const v = await verifyAction(
      { action: "navigate", url: "https://b.com", expectedOutcome: { urlContains: "b.com" } },
      {},
      pre,
      () => snapshot({ url: "https://a.com" }),
    );
    expect(v.ok).toBe(false);
  });

  it("verifies content change from hint value", async () => {
    const pre = snapshot({ visibleText: "before" });
    const v = await verifyAction(
      { action: "type", target: { elementId: "el_001" }, expectedOutcome: { elementState: { textContains: "hello" } } },
      { value: "hello" },
      pre,
      () => snapshot({ visibleText: "besides hello" }),
    );
    expect(v.ok).toBe(true);
  });

  it("confirms typing by reading the input value back from the fresh snapshot", async () => {
    const pre = snapshot();
    const v = await verifyAction(
      { action: "type", target: { elementId: "el_001" }, expectedOutcome: { type: "element_state" } },
      { value: "tutorial" },
      pre,
      () => snapshot({
        elements: [
          { id: "el_001", role: "textbox", name: "Search", tag: "input", visible: true, enabled: true, focused: false, value: "tutorial", rect: { x: 0, y: 0, w: 50, h: 20 } },
        ],
      }),
    );
    expect(v.ok).toBe(true);
    expect(v.evidence.some((e) => e.includes("typed value"))).toBe(true);
  });

  it("fails honestly when the typed value was not applied (no rubber-stamp)", async () => {
    const pre = snapshot();
    const v = await verifyAction(
      { action: "type", target: { elementId: "el_001" }, expectedOutcome: { type: "element_state" } },
      { value: "tutorial" },
      pre,
      () => snapshot({ elements: [{ id: "el_001", role: "textbox", name: "Search", tag: "input", visible: true, enabled: true, focused: false, value: "", rect: { x: 0, y: 0, w: 50, h: 20 } }] }),
    );
    expect(v.ok).toBe(false);
    expect(v.evidence.some((e) => e.includes("typed value missing"))).toBe(true);
  });
});