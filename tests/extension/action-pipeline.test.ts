import { describe, it, expect } from "vitest";
import { parseActions } from "@/llm/response-parser";
import { validateAction as validateSchema } from "@/shared/action-schema";
import { validateAction as validateTarget } from "@/agent/action-validator";
import { assessAction, resolveTargetContext } from "@/agent/risk-manager";
import type { ObservationSnapshot } from "@/shared/messages";

/**
 * Phase 4 — the full validation pipeline every Groq action must survive:
 * structured parse → schema → target (live DOM) → risk. Each stage is
 * exercised with passing and failing model output.
 */
function snapshot(over: Partial<ObservationSnapshot> = {}): ObservationSnapshot {
  return {
    url: "https://www.youtube.com",
    title: "YouTube",
    tabId: 7,
    pageType: "content",
    viewport: { w: 1000, h: 800 },
    scrollY: 0,
    scrollH: 0,
    loading: false,
    visibleText: "videos",
    elements: [
      { id: "el_001", role: "searchbox", name: "Search", tag: "input", visible: true, enabled: true, focused: false, type: "search", value: "", rect: { x: 0, y: 0, w: 50, h: 20 } },
      { id: "el_002", role: "button", name: "Search", tag: "button", visible: true, enabled: true, focused: false, rect: { x: 0, y: 0, w: 50, h: 20 } },
      { id: "el_003", role: "button", name: "Buy Premium", tag: "button", visible: true, enabled: true, focused: false, rect: { x: 0, y: 0, w: 50, h: 20 } },
      { id: "el_004", role: "button", name: "Removed", tag: "button", visible: false, enabled: true, focused: false, rect: { x: 0, y: 0, w: 50, h: 20 } },
    ],
    counted: 4,
    createdAt: Date.now(),
    ...over,
  };
}

/** Run one raw model string through parse → schema → target → risk. */
function pipeline(raw: string, snap: ObservationSnapshot) {
  const parsed = parseActions(raw);
  if (!parsed.ok) return { stage: "parse", parsed };
  const schema = validateSchema(parsed.actions[0]);
  if (!schema.ok || !schema.action) return { stage: "schema", parsed, schema };
  const target = validateTarget(schema.action, snap);
  if (!target.ok) return { stage: "target", parsed, schema, target };
  // Mirrors the controller: risk sees the resolved label, not a bare id.
  const risk = assessAction(resolveTargetContext(schema.action, snap), snap);
  return { stage: "risk", parsed, schema, target, risk };
}

describe("Phase 4 — Groq action validation pipeline", () => {
  it("a valid click survives every stage as LOW risk", () => {
    const r = pipeline('{"action": "click", "target": {"elementId": "el_002"}}', snapshot());
    expect(r.stage).toBe("risk");
    expect(r.risk!.level).toBe("LOW");
    expect(r.risk!.requiresConfirmation).toBe(false);
  });

  it("an invented element id dies at target validation, never at execution", () => {
    const r = pipeline('{"action": "click", "target": {"elementId": "el_999"}}', snapshot());
    expect(r.stage).toBe("target");
    expect(r.target).toMatchObject({ ok: false });
  });

  it("a hidden element dies at target validation", () => {
    const r = pipeline('{"action": "click", "target": {"elementId": "el_004"}}', snapshot());
    expect(r.stage).toBe("target");
  });

  it("an unknown action dies at schema validation", () => {
    const parsed = parseActions('{"action": "hack_the_planet"}');
    expect(parsed.ok).toBe(false);
  });

  it("malformed model output dies at parse", () => {
    const r = pipeline("do the thing please", snapshot());
    expect(r.stage).toBe("parse");
  });

  it("a payment click passes validation but is gated at risk", () => {
    const r = pipeline('{"action": "click", "target": {"elementId": "el_003"}}', snapshot());
    expect(r.stage).toBe("risk");
    expect(r.risk!.level).toBe("HIGH");
    expect(r.risk!.requiresConfirmation).toBe(true);
  });

  it("a navigate action skips target validation (no DOM needed)", () => {
    const parsed = parseActions('{"action": "navigate", "url": "https://www.youtube.com"}');
    expect(parsed.ok).toBe(true);
    const schema = validateSchema(parsed.actions[0]);
    expect(schema.ok).toBe(true);
    const target = validateTarget(schema.action!, snapshot());
    expect(target.ok).toBe(true);
    const risk = assessAction(schema.action!, snapshot());
    expect(risk.level).toBe("LOW");
  });

  it("a DOM action on chrome://newtab/ is rejected at target validation", () => {
    const internal = snapshot({ url: "chrome://newtab/", pageType: "unsupported", elements: [], visibleText: "" });
    const r = pipeline('{"action": "click", "target": {"elementId": "el_001"}}', internal);
    expect(r.stage).toBe("target");
    expect(r.target).toMatchObject({ ok: false });
  });

  it("navigation from chrome://newtab/ passes every stage as LOW risk", () => {
    const internal = snapshot({ url: "chrome://newtab/", pageType: "unsupported", elements: [], visibleText: "" });
    const r = pipeline('{"action": "navigate", "url": "https://www.youtube.com"}', internal);
    expect(r.stage).toBe("risk");
    expect(r.risk!.level).toBe("LOW");
    expect(r.risk!.requiresConfirmation).toBe(false);
  });
});