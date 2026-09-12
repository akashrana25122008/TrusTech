import { describe, it, expect } from "vitest";
import { planNextAction } from "@/agent/deterministic-planner";
import { interpretTask } from "@/agent/task-interpreter";
import type { TaskGoal } from "@/agent/types";
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
    visibleText: "book your journey",
    elements: [],
    counted: 0,
    createdAt: Date.now(),
    ...over,
  };
}

describe("Part 11 — task behaviors (choose / select / date)", () => {
  it("interprets a named option from a choose-style goal", () => {
    const goal = interpretTask("select AC coach coach class");
    expect(goal.entities.find((e) => e.label === "option")?.value).toBe("AC coach coach class");
  });

  it("interprets a date from a booking goal", () => {
    const goal = interpretTask("depart on 25/12/2026");
    expect(goal.entities.find((e) => e.label === "date")?.value).toBe("25/12/2026");
  });

  it("plans a select action with expected outcome for a combobox", () => {
    const goal: TaskGoal = {
      goal: "select AC coach",
      intent: "booking",
      entities: [{ label: "option", value: "AC coach", raw: "AC coach" }],
      steps: ["select available options"],
      startUrl: undefined,
    };
    const plan = planNextAction(
      goal,
      0,
      snapshot({
        elements: [
          { id: "el_001", role: "combobox", name: "Class", tag: "select", visible: true, enabled: true, focused: false, rect: { x: 0, y: 0, w: 50, h: 20 } },
        ],
      }),
    );
    expect(plan?.action.action).toBe("select");
    if (plan?.action.action !== "select") return;
    expect(plan.action.target?.elementId).toBe("el_001");
    expect(plan.action.option).toBe("AC coach");
    expect(plan.action.expectedOutcome?.elementState?.selected).toBe(true);
  });

  it("plans a typed date for a date input with verification", () => {
    const goal: TaskGoal = {
      goal: "depart on 25/12/2026",
      intent: "booking",
      entities: [{ label: "date", value: "25/12/2026", raw: "25/12/2026" }],
      steps: ["pick a departure date"],
      startUrl: undefined,
    };
    const plan = planNextAction(
      goal,
      0,
      snapshot({
        elements: [
          { id: "el_002", role: "date", name: "Departure", tag: "input", visible: true, enabled: true, focused: false, type: "date", rect: { x: 0, y: 0, w: 50, h: 20 } },
        ],
      }),
    );
    expect(plan?.action.action).toBe("type");
    if (plan?.action.action !== "type") return;
    expect(plan.action.target?.elementId).toBe("el_002");
    expect(plan.action.text).toBe("25/12/2026");
    expect(plan.action.expectedOutcome?.type).toBe("element_state");
  });

  it("falls through to reading the page when no widget matches", () => {
    const goal: TaskGoal = {
      goal: "choose Mumbai",
      intent: "general",
      entities: [],
      steps: ["interact as needed"],
      startUrl: undefined,
    };
    const plan = planNextAction(goal, 0, snapshot());
    expect(plan?.action.action).toBe("finish");
  });
});