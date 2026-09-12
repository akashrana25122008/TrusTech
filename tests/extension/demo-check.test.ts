import { describe, it, expect } from "vitest";
import { interpretTask } from "@/agent/task-interpreter";

describe("demo flows", () => {
  it("runs the three demo tasks through the interpreter", () => {
    const demos = [
      "Search YouTube for a tutorial on drawing with neural networks",
      "Find the best laptop under ₹50,000 on amazon.in and return the top 2 options",
      "Look up trains from Delhi to Lucknow tomorrow and read out the options",
    ];
    for (const d of demos) {
      const goal = interpretTask(d);
      expect(goal.steps.length).toBeGreaterThan(0);
      expect(goal.goal).toBeTruthy();
    }
  });
});
