import { describe, it, expect } from "vitest";
import { mapAgentToBot } from "@/ui/agent-bot/bot-state-adapter";
import type { AgentStateKey } from "@/shared/types";

describe("mapAgentToBot", () => {
  it("maps every agent state to a bot state", () => {
    const cases: Array<[AgentStateKey, string]> = [
      ["IDLE", "idle"],
      ["OBSERVING", "observing"],
      ["THINKING", "thinking"],
      ["ACTING", "acting"],
      ["WAITING", "waiting"],
      ["SUCCESS", "success"],
      ["PAUSED", "paused"],
      ["ERROR", "error"],
    ];
    for (const [agent, bot] of cases) {
      expect(mapAgentToBot(agent)).toBe(bot);
    }
  });

  it("never produces an undefined bot state", () => {
    const all: AgentStateKey[] = ["IDLE", "OBSERVING", "THINKING", "ACTING", "SUCCESS", "WAITING", "PAUSED", "ERROR"];
    for (const agent of all) {
      const bot = mapAgentToBot(agent);
      expect(["idle", "observing", "thinking", "acting", "waiting", "success", "paused", "error"]).toContain(bot);
    }
  });
});