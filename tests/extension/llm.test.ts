import { describe, it, expect } from "vitest";
import { parseActions, extractJson } from "@/llm/response-parser";
import { buildPrompt } from "@/llm/prompt-builder";
import type { ObservationSnapshot } from "@/shared/messages";

function snapshot(over: Partial<ObservationSnapshot> = {}): ObservationSnapshot {
  return {
    url: "https://www.google.com",
    title: "Google",
    tabId: 1,
    pageType: "search",
    viewport: { w: 1000, h: 800 },
    scrollY: 0,
    scrollH: 0,
    loading: false,
    visibleText: "results for titanium",
    elements: [
      { id: "el_001", role: "textbox", name: "Search", tag: "input", visible: true, enabled: true, focused: false, rect: { x: 0, y: 0, w: 500, h: 30 } },
    ],
    counted: 1,
    createdAt: Date.now(),
    ...over,
  };
}

describe("response-parser", () => {
  it("parses a code-fenced single action", () => {
    const raw = "```json\n{\"action\":\"click\",\"target\":{\"elementId\":\"el_001\"}}\n```";
    const r = parseActions(raw);
    expect(r.ok).toBe(true);
    expect(r.actions[0].target?.elementId).toBe("el_001");
  });

  it("parses an action array", () => {
    const r = parseActions(
      JSON.stringify([
        { action: "type", target: { elementId: "el_001" }, text: "hi" },
        { action: "press_key", key: "Enter" },
      ]),
    );
    expect(r.ok).toBe(true);
    expect(r.actions).toHaveLength(2);
  });

  it("rejects invalid JSON", () => {
    const r = parseActions("not json at all");
    expect(r.ok).toBe(false);
  });

  it("drops invalid actions but keeps valid ones", () => {
    const r = parseActions(JSON.stringify([{ action: "teleport" }, { action: "finish", result: "x" }]));
    expect(r.ok).toBe(false);
    expect(r.actions.map((a) => a.action)).toEqual(["finish"]);
  });

  it("extractJson resilient to leading prose", () => {
    expect(extractJson('Ok, here: {"action":"finish","result":"y"}')).toBe('{"action":"finish","result":"y"}');
  });
});

describe("prompt-builder", () => {
  it("sanitizes page text through the privacy firewall", () => {
    const p = buildPrompt("find phone under 20000", "commerce", snapshot({ visibleText: "email me at a@b.com" }), "");
    expect(p.userPrompt).toContain("[email]");
    expect(p.userPrompt).not.toContain("a@b.com");
  });

  it("lists indexed interactive elements", () => {
    const p = buildPrompt("find phone", "commerce", snapshot(), "");
    expect(p.userPrompt).toContain("el_001 textbox");
  });
});