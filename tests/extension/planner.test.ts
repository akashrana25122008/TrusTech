import { describe, it, expect } from "vitest";
import { planFor } from "@/agent/planner";
import { buildGuardedTimeline } from "@/agent/controller";

describe("planFor", () => {
  it("emits an ordered lifecycle ending in review", () => {
    const plan = planFor("search youtube tutorial");
    expect(plan.events[0].status).toBe("OBSERVING");
    expect(plan.events.some((e) => e.status === "SUCCESS")).toBe(true);
    expect(plan.events[plan.events.length - 1].status).toBe("WAITING");
  });
});

describe("buildGuardedTimeline (AgentController)", () => {
  it("inserts a confirmation gate for financial tasks", () => {
    const timeline = buildGuardedTimeline("buy a train ticket on irctc");
    expect(timeline.gate).toBeDefined();
    expect(timeline.gate!.hold!.level).toBe("high");
    expect(timeline.runNow.every((s) => s.event.status !== "WAITING")).toBe(true);
    expect(timeline.deferred.length).toBeGreaterThan(0);
  });

  it("keeps only the low final review for safe tasks", () => {
    const timeline = buildGuardedTimeline("search youtube tutorial");
    expect(timeline.gate?.hold?.label).toBe("Final review");
    expect(timeline.gate?.hold?.level).toBe("low");
  });

  it("runs the privacy firewall over page context", () => {
    const timeline = buildGuardedTimeline("open gmail");
    expect(timeline.privacy.redactedFields).toBeGreaterThan(0);
  });
});