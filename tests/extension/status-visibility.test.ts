/**
 * Landing-view neutrality: the main view stays calm for every outcome;
 * execution truth lives in the processing drawer. Pure-function policy.
 */
import { describe, it, expect } from "vitest";
import { displayActionText, finalStateSummary } from "@/ui/components/statusText";

describe("landing-view neutrality", () => {
  it("main view never shows a technical failure dump", () => {
    expect(displayActionText("ERROR", "exhausted 3 retries: element el_999 is not in the current observation")).toBe("Stopped.");
    expect(displayActionText("ERROR", "Browser page cannot be controlled.")).toBe("Stopped.");
  });

  it("main view passes through real running/completion text", () => {
    expect(displayActionText("ACTING", "Executing click → Search…")).toBe("Executing click → Search…");
    expect(displayActionText("THINKING", "Planning the next step…")).toBe("Planning the next step…");
    expect(displayActionText("PAUSED", "Agent paused — press resume to continue.")).toBe("Agent paused — press resume to continue.");
    expect(displayActionText("WAITING", "Waiting for your confirmation…")).toBe("Waiting for your confirmation…");
    expect(displayActionText("SUCCESS", "Opened beginner C tutorial on YouTube")).toBe("Opened beginner C tutorial on YouTube");
    expect(displayActionText("IDLE", "Standing by.")).toBe("Standing by.");
  });

  it("drawer reports COMPLETED with the real result", () => {
    expect(finalStateSummary("SUCCESS", "Opened beginner C tutorial on YouTube")).toEqual({
      label: "COMPLETED",
      detail: "Opened beginner C tutorial on YouTube",
    });
  });

  it("drawer reports STOPPED with the concise failure reason", () => {
    expect(finalStateSummary("ERROR", "exhausted 3 retries: stale element")).toEqual({
      label: "STOPPED",
      detail: "exhausted 3 retries: stale element",
    });
  });

  it("drawer has no final-state block while running", () => {
    for (const s of ["IDLE", "OBSERVING", "THINKING", "ACTING", "WAITING", "PAUSED"] as const) {
      expect(finalStateSummary(s, "Working…")).toBeNull();
    }
  });
});
