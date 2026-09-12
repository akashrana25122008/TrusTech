import { describe, it, expect } from "vitest";
import { validateAction, ALL_ACTION_NAMES } from "@/shared/action-schema";

describe("action-schema validateAction", () => {
  it("accepts a valid click with target", () => {
    const r = validateAction({ action: "click", target: { elementId: "el_001" } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.action!.action).toBe("click");
  });

  it("rejects unknown actions", () => {
    const r = validateAction({ action: "teleport" });
    expect(r.ok).toBe(false);
  });

  it("requires a target for page-level interactions", () => {
    const r = validateAction({ action: "type", text: "hi" });
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain("requires a target");
  });

  it("rejects out-of-scope actions via the allowed filter", () => {
    const r = validateAction({ action: "navigate", url: "https://x.io" }, ["click"]);
    expect(r.ok).toBe(false);
    expect(r.filtered).toBe("navigate");
  });

  it("requires url for navigate", () => {
    const r = validateAction({ action: "navigate" });
    expect(r.ok).toBe(false);
  });

  it("requires key for press_key and ms for wait", () => {
    expect(validateAction({ action: "press_key" }).ok).toBe(false);
    expect(validateAction({ action: "wait" }).ok).toBe(false);
    expect(validateAction({ action: "wait", ms: 250 }).ok).toBe(true);
  });

  it("clamps confidence to 0..1", () => {
    const r = validateAction({ action: "finish", confidence: 42 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.action!.confidence).toBe(1);
  });

  it("exposes the full allowed action surface", () => {
    expect(ALL_ACTION_NAMES.length).toBe(25);
    expect(ALL_ACTION_NAMES).toContain("search");
  });

  it("search requires a query but not a target (executor self-resolves)", () => {
    expect(validateAction({ action: "search" }).ok).toBe(false);
    expect(validateAction({ action: "search", text: "" }).ok).toBe(false);
    expect(validateAction({ action: "search", text: "beginner C tutorial" }).ok).toBe(true);
    expect(
      validateAction({ action: "search", target: { elementId: "el_010" }, text: "beginner C tutorial" }).ok,
    ).toBe(true);
  });
});