import { describe, it, expect } from "vitest";
import { buildLlmPlanner } from "@/agent/llm-planner";
import type { LlmProvider, LlmResponse } from "@/llm/llm-client";
import type { TaskGoal } from "@/agent/types";
import type { ObservationSnapshot } from "@/shared/messages";

function snap(over: Partial<ObservationSnapshot> = {}): ObservationSnapshot {
  return {
    url: "https://example.com",
    title: "t",
    tabId: 1,
    pageType: "search",
    viewport: { w: 1000, h: 800 },
    scrollY: 0,
    scrollH: 0,
    loading: false,
    visibleText: "Welcome",
    elements: [
      { id: "el_001", role: "searchbox", name: "Search", tag: "input", visible: true, enabled: true, focused: false, type: "search", value: "", rect: { x: 0, y: 0, w: 50, h: 20 } },
      { id: "el_002", role: "button", name: "Go", tag: "button", visible: true, enabled: true, focused: false, rect: { x: 0, y: 0, w: 50, h: 20 } },
    ],
    counted: 2,
    createdAt: Date.now(),
    ...over,
  };
}

const SEARCH_TASK: TaskGoal = {
  goal: "search youtube tutorial",
  intent: "search",
  entities: [],
  steps: ["navigate to the search engine", "enter the query", "submit the search", "read and return the top results"],
  startUrl: "https://www.google.com/search?q=youtube+tutorial",
};

function mockProvider(response: LlmResponse, available = true): LlmProvider {
  return {
    name: "mock",
    available: async () => available,
    complete: async () => response,
  };
}

describe("Part 12 — LLM planner integration", () => {
  it("falls back to deterministic planner when provider is unavailable", async () => {
    const planner = buildLlmPlanner(mockProvider({ ok: false }, false));
    const result = await planner(SEARCH_TASK, 0, snap());
    // Deterministic planner would produce a navigate for step 0.
    expect(result?.action.action).toBe("navigate");
  });

  it("uses the LLM action when the provider returns a valid action", async () => {
    const planner = buildLlmPlanner(
      mockProvider({
        ok: true,
        actions: [{ action: "click", target: { elementId: "el_002" }, confidence: 0.9 }],
      }),
    );
    const result = await planner(SEARCH_TASK, 1, snap());
    expect(result?.action.action).toBe("click");
    expect(result?.action.target?.elementId).toBe("el_002");
    expect(result?.justification).toContain("LLM (mock)");
  });

  it("falls back to deterministic planner on invalid LLM output", async () => {
    const planner = buildLlmPlanner(
      mockProvider({ ok: false, raw: "sorry, I cannot do that" }),
    );
    const result = await planner(SEARCH_TASK, 0, snap());
    // Deterministic fallback still produces a navigate action.
    expect(result?.action.action).toBe("navigate");
  });

  it("falls back to deterministic planner when the provider throws", async () => {
    const brokenProvider: LlmProvider = {
      name: "broken",
      available: async () => true,
      complete: async () => { throw new Error("network down"); },
    };
    const planner = buildLlmPlanner(brokenProvider);
    const result = await planner(SEARCH_TASK, 0, snap());
    expect(result?.action.action).toBe("navigate");
  });

  it("deterministic planner returns null when all steps are exhausted (same for LLM planner)", async () => {
    const planner = buildLlmPlanner(mockProvider({ ok: false }, false));
    const result = await planner(SEARCH_TASK, 99, snap());
    expect(result).toBeNull();
  });

  it("preserves the failure category when falling back (no silent fallback)", async () => {
    const seen: Array<{ provider: string; stage: string; error?: string }> = [];
    const ctx = { onProviderError: (info: { provider: string; stage: "unavailable" | "request" | "empty" | "aborted"; error?: string }) => seen.push(info) };

    await buildLlmPlanner(mockProvider({ ok: false }, false))(SEARCH_TASK, 0, snap(), ctx);
    expect(seen).toEqual([{ provider: "mock", stage: "unavailable", error: undefined }]);

    await buildLlmPlanner(mockProvider({ ok: false, error: "gateway_timeout" }))(SEARCH_TASK, 0, snap(), ctx);
    expect(seen[1]).toEqual({ provider: "mock", stage: "request", error: "gateway_timeout" });

    await buildLlmPlanner(mockProvider({ ok: true, actions: [] }))(SEARCH_TASK, 0, snap(), ctx);
    expect(seen[2]).toEqual({ provider: "mock", stage: "empty", error: undefined });

    const broken: LlmProvider = {
      name: "broken",
      available: async () => true,
      complete: async () => { throw new Error("network down"); },
    };
    await buildLlmPlanner(broken)(SEARCH_TASK, 0, snap(), ctx);
    expect(seen[3]).toEqual({ provider: "broken", stage: "request", error: "network down" });
  });
});
