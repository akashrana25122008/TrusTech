import { describe, it, expect, vi } from "vitest";
import { GatewayLlmProvider } from "@/llm/gateway-provider";
import { buildLlmPlanner } from "@/agent/llm-planner";
import { planNextAction } from "@/agent/deterministic-planner";
import type { ObservationSnapshot } from "@/shared/messages";
import type { TaskGoal } from "@/agent/types";
import fs from "node:fs";
import path from "node:path";

function sampleSnapshot(over: Partial<ObservationSnapshot> = {}): ObservationSnapshot {
  return {
    url: "https://example.com",
    title: "Example Domain",
    tabId: 10,
    pageType: "content",
    viewport: { w: 1200, h: 800 },
    scrollY: 0,
    scrollH: 800,
    loading: false,
    visibleText: "Welcome to Example Domain with a search input",
    elements: [
      {
        id: "el_001",
        role: "textbox",
        name: "Search",
        tag: "input",
        visible: true,
        enabled: true,
        focused: false,
        rect: { x: 10, y: 10, w: 200, h: 30 },
      },
      {
        id: "el_002",
        role: "button",
        name: "Submit",
        tag: "button",
        visible: true,
        enabled: true,
        focused: false,
        rect: { x: 220, y: 10, w: 80, h: 30 },
      },
    ],
    counted: 2,
    createdAt: Date.now(),
    ...over,
  };
}

describe("GatewayLlmProvider", () => {
  it("makes a successful gateway request and returns validated actions", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    let capturedBody: any = null;

    const mockFetch = vi.fn(async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedMethod = init?.method ?? "GET";
      if (init?.body) {
        capturedBody = JSON.parse(init.body as string);
      }
      return new Response(
        JSON.stringify({
          action: {
            action: "click",
            target: { elementId: "el_002", role: "button", name: "Submit" },
            confidence: 0.95,
            expectedOutcome: { type: "content_change" },
          },
          model: "openai/gpt-oss-20b",
          usage: { prompt_tokens: 45, completion_tokens: 15 },
          redacted: 0,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const provider = new GatewayLlmProvider({
      baseUrl: "http://localhost:8000",
      fetchFn: mockFetch as any,
    });

    const snapshot = sampleSnapshot();
    const result = await provider.complete({
      stepContext: {
        task: { goal: "submit the form", intent: "submission" },
        observation: snapshot,
        history: ["type el_001: ok"],
        verification: { ok: true, action: "type" },
      },
    });

    expect(result.ok).toBe(true);
    expect(result.actions).toHaveLength(1);
    expect(result.actions![0].action).toBe("click");
    expect(result.actions![0].target?.elementId).toBe("el_002");
    expect(capturedUrl).toBe("http://localhost:8000/api/agent/step");
    expect(capturedMethod).toBe("POST");
    expect(capturedBody.task.goal).toBe("submit the form");
    expect(capturedBody.task.intent).toBe("submission");
    expect(capturedBody.history).toEqual(["type el_001: ok"]);
    expect(capturedBody.verification).toEqual({ ok: true, action: "type" });
    expect(capturedBody.observation.url).toBe("https://example.com");
  });

  it("handles malformed gateway responses (non-JSON, missing action, invalid schema)", async () => {
    // 1. Non-JSON body
    const nonJsonFetch = vi.fn(async () => {
      return new Response("<html><body>502 Bad Gateway</body></html>", {
        status: 502,
        headers: { "Content-Type": "text/html" },
      });
    });
    const provider1 = new GatewayLlmProvider({ fetchFn: nonJsonFetch as any });
    const res1 = await provider1.complete({});
    expect(res1.ok).toBe(false);
    expect(res1.error).toMatch(/gateway_malformed_json/i);

    // 2. Missing action property in JSON
    const missingActionFetch = vi.fn(async () => {
      return new Response(JSON.stringify({ model: "openai/gpt-oss-20b", usage: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const provider2 = new GatewayLlmProvider({ fetchFn: missingActionFetch as any });
    const res2 = await provider2.complete({});
    expect(res2.ok).toBe(false);
    expect(res2.error).toMatch(/gateway_missing_action/i);

    // 3. Invalid action schema (e.g. unknown action name)
    const invalidActionFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          action: { action: "non_existent_tool", foo: "bar" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    const provider3 = new GatewayLlmProvider({ fetchFn: invalidActionFetch as any });
    const res3 = await provider3.complete({});
    expect(res3.ok).toBe(false);
    expect(res3.error).toMatch(/gateway_invalid_action/i);
  });

  it("reports unavailable and returns error when backend is offline", async () => {
    const offlineFetch = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:8000");
    });
    const provider = new GatewayLlmProvider({ fetchFn: offlineFetch as any });

    const isAvailable = await provider.available();
    expect(isAvailable).toBe(false);

    const res = await provider.complete({});
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/gateway_network_error/i);
  });

  it("handles backend error responses with status and detail", async () => {
    const errorFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({ detail: "reasoning engine unavailable" }),
        { status: 503, headers: { "Content-Type": "application/json" } },
      );
    });
    const provider = new GatewayLlmProvider({ fetchFn: errorFetch as any });
    const res = await provider.complete({});
    expect(res.ok).toBe(false);
    expect(res.error).toContain("503");
    expect(res.error).toContain("reasoning engine unavailable");
  });

  it("handles request timeout cleanly", async () => {
    const slowFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("The operation was aborted.");
          err.name = "AbortError";
          reject(err);
        });
      });
    });

    const provider = new GatewayLlmProvider({
      fetchFn: slowFetch as any,
      timeoutMs: 50,
      healthTimeoutMs: 50,
    });

    const available = await provider.available();
    expect(available).toBe(false);

    const res = await provider.complete({});
    expect(res.ok).toBe(false);
    expect(res.error).toBe("gateway_timeout");
  });
});

import { interpretTask } from "@/agent/task-interpreter";

describe("Runtime wiring & Fallback behavior", () => {
  const goal: TaskGoal = interpretTask("search titanium");

  it("falls back to deterministic planner when backend is unavailable, without falsely claiming Groq active", async () => {
    const offlineProvider = new GatewayLlmProvider({
      fetchFn: vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }) as any,
    });

    const planner = buildLlmPlanner(offlineProvider);
    const snapshot = sampleSnapshot();

    const plan = await planner(goal, 0, snapshot);
    expect(plan).not.toBeNull();
    // Deterministic planner plan matches
    const expectedDet = planNextAction(goal, 0, snapshot);
    expect(plan!.action).toEqual(expectedDet!.action);
    // Justification must NOT claim to be from Groq/LLM
    expect(plan!.justification).not.toContain("groq-gateway");
    expect(plan!.justification).not.toContain("LLM");
  });

  it("falls back to deterministic planner if gateway complete() returns error", async () => {
    const failingProvider = new GatewayLlmProvider({
      fetchFn: vi.fn(async (url: string) => {
        if (url.endsWith("/health")) {
          return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
        }
        return new Response(JSON.stringify({ detail: "model overloaded" }), { status: 503 });
      }) as any,
    });

    const planner = buildLlmPlanner(failingProvider);
    const snapshot = sampleSnapshot();

    const plan = await planner(goal, 0, snapshot);
    expect(plan).not.toBeNull();
    const expectedDet = planNextAction(goal, 0, snapshot);
    expect(plan!.action).toEqual(expectedDet!.action);
    expect(plan!.justification).not.toContain("groq-gateway");
    expect(plan!.justification).not.toContain("LLM");
  });

  it("uses Groq gateway response and reports LLM justification when available", async () => {
    const workingProvider = new GatewayLlmProvider({
      fetchFn: vi.fn(async (url: string) => {
        if (url.endsWith("/health")) {
          return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
        }
        return new Response(
          JSON.stringify({
            action: {
              action: "click",
              target: { elementId: "el_002" },
              expectedOutcome: { type: "navigation" },
            },
            model: "openai/gpt-oss-20b",
          }),
          { status: 200 },
        );
      }) as any,
    });

    const planner = buildLlmPlanner(workingProvider);
    const snapshot = sampleSnapshot();

    const plan = await planner(goal, 0, snapshot);
    expect(plan).not.toBeNull();
    expect(plan!.action.action).toBe("click");
    expect(plan!.action.target?.elementId).toBe("el_002");
    expect(plan!.justification).toContain("LLM (groq-gateway)");
  });
});

describe("Security & Secret Isolation in Extension", () => {
  it("ensures GROQ_API_KEY is not present in extension source files", () => {
    const srcDir = path.resolve(__dirname, "../../extension/src");
    const files = fs.readdirSync(srcDir, { recursive: true }) as string[];

    for (const rel of files) {
      const fullPath = path.join(srcDir, rel);
      if (fs.statSync(fullPath).isFile() && /\.(ts|tsx|js|json)$/.test(rel)) {
        const content = fs.readFileSync(fullPath, "utf-8");
        expect(content).not.toContain("GROQ_API_KEY");
      }
    }
  });

  it("ensures no direct Groq API endpoint (api.groq.com) exists in extension source files", () => {
    const srcDir = path.resolve(__dirname, "../../extension/src");
    const files = fs.readdirSync(srcDir, { recursive: true }) as string[];

    for (const rel of files) {
      const fullPath = path.join(srcDir, rel);
      if (fs.statSync(fullPath).isFile() && /\.(ts|tsx|js|json)$/.test(rel)) {
        const content = fs.readFileSync(fullPath, "utf-8");
        expect(content).not.toContain("api.groq.com");
      }
    }
  });
});
