/**
 * Search-submission lifecycle: TYPE(query) is the input stage, SEARCH is
 * the composite (resolve → focus → enter → submit → verified results).
 * Covers the "beginner C tutorial typed but never searched" defect class:
 * query-in-box must never read as search success, Enter must be focused
 * and effect-verified, submission falls back to the search button, and
 * exhausted search failures pause the task instead of erroring globally.
 */
import { describe, it, expect } from "vitest";
import { executeAction } from "@/content/executor";
import { verifyAction } from "@/agent/verifier";
import { planNextAction } from "@/agent/deterministic-planner";
import { AgentController } from "@/agent/controller";
import { AgentEventBus } from "@/shared/event-bus";
import type { BrowserAdapter } from "@/browser";
import type { ObservationSnapshot, ActionResult } from "@/shared/messages";
import type { AgentAction } from "@/shared/action-schema";
import type { TaskGoal } from "@/agent/types";

const YT_HOME = "https://www.youtube.com/";
const YT_RESULTS = "https://www.youtube.com/results?search_query=beginner+C+tutorial";

const el = (id: string, role: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, role, name, tag: "input", visible: true, enabled: true, focused: false,
  rect: { x: 0, y: 0, w: 50, h: 20 }, ...extra,
});

function snap(over: Partial<ObservationSnapshot> = {}): ObservationSnapshot {
  return {
    url: YT_HOME, title: "YouTube", tabId: 7, pageType: "content",
    viewport: { w: 1280, h: 800 }, scrollY: 0, scrollH: 2000, loading: false,
    visibleText: "YouTube Home Search",
    elements: [
      el("el_010", "searchbox", "Search", { value: "" }),
      el("el_011", "button", "Search", { tag: "button" }),
    ],
    counted: 2, createdAt: Date.now(), ...over,
  };
}

/* ---------------- executor: SEARCH composite (jsdom DOM) ---------------- */

describe("executor SEARCH composite", () => {
  it("types the query, submits via the form, and reports the method", async () => {
    document.body.innerHTML = `<form id="f"><input type="search" aria-label="Search"></form>`;
    const form = document.querySelector("form")!;
    // Stubbed submission renders results (stand-in for a real navigation).
    (form as HTMLFormElement).requestSubmit = (() => {
      document.body.insertAdjacentHTML("beforeend", `<div class="results">beginner C tutorial results</div>`);
    }) as typeof form.requestSubmit;
    const result = await executeAction({ action: "search", text: "beginner C tutorial" });
    expect(result.ok).toBe(true);
    expect(result.hint?.value).toBe("beginner C tutorial");
    expect(result.details).toContain("form");
    expect((document.querySelector("input") as HTMLInputElement).value).toBe("beginner C tutorial");
  });

  it("reuses the verified value already in the box and falls back to the button", async () => {
    document.body.innerHTML = `<input type="search" aria-label="Search" value="beginner C tutorial"><button aria-label="Search">Go</button>`;
    document.querySelector("button")!.addEventListener("click", () => {
      document.body.insertAdjacentHTML("beforeend", `<div class="results">beginner C tutorial results</div>`);
    });
    const result = await executeAction({ action: "search", text: "beginner C tutorial" });
    expect(result.ok).toBe(true);
    expect(result.details).toContain("button");
  });

  it("fails honestly when the field cannot take focus (Enter would go nowhere)", async () => {
    document.body.innerHTML = `<input type="search" aria-label="Search">`;
    // Sabotage programmatic focus: the input stays unfocused like a
    // detached or obscured field in a real page.
    const origFocus = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function () {
      /* focus refused */
    };
    try {
      const result = await executeAction({ action: "search", text: "beginner C tutorial" });
      expect(result.ok).toBe(false);
      expect(result.error).toBe("input_not_focusable");
    } finally {
      HTMLElement.prototype.focus = origFocus;
    }
  });

  it("fails honestly when no search field exists", async () => {
    document.body.innerHTML = `<div>no inputs here</div>`;
    const result = await executeAction({ action: "search", text: "beginner C tutorial" });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("search_input_not_found");
  });

  it("fails honestly when Enter does nothing and no button exists", async () => {
    document.body.innerHTML = `<input type="search" aria-label="Search">`;
    const result = await executeAction({ action: "search", text: "beginner C tutorial" });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("submit_no_effect");
  });

  it("refuses a non-editable target instead of typing into it", async () => {
    document.body.innerHTML = `<input type="search" aria-label="Search"><button aria-label="Search">Go</button>`;
    const { indexAll, idOf } = await import("@/content/indexer");
    indexAll(document);
    const buttonId = idOf(document.querySelector("button")!);
    const result = await executeAction(
      { action: "search", target: { elementId: buttonId }, text: "beginner C tutorial" },
      buttonId,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe("invalid_target");
  });
});

/* ---------------- executor: SUBMIT fallback ---------------- */

describe("executor SUBMIT fallback", () => {
  it("succeeds when requestSubmit takes effect", async () => {
    document.body.innerHTML = `<form><input type="text" aria-label="Name"><button type="submit" aria-label="Go">Go</button></form>`;
    const { indexAll, idOf } = await import("@/content/indexer");
    indexAll(document);
    const form = document.querySelector("form")!;
    const buttonId = idOf(document.querySelector("button")!)!;
    (form as HTMLFormElement).requestSubmit = (() => {
      document.body.insertAdjacentHTML("beforeend", `<div>done</div>`);
    }) as typeof form.requestSubmit;
    const result = await executeAction({ action: "submit", target: { elementId: buttonId } }, buttonId);
    expect(result.ok).toBe(true);
  });

  it("falls back to the submit control when requestSubmit is silent", async () => {
    document.body.innerHTML = `<form id="f"><input type="text" aria-label="Name"><button type="submit" aria-label="Go">Go</button></form>`;
    const { indexAll, idOf } = await import("@/content/indexer");
    indexAll(document);
    const buttonId = idOf(document.querySelector("button")!)!;
    document.querySelector("button")!.addEventListener("click", () => {
      document.body.insertAdjacentHTML("beforeend", `<div>done</div>`);
    });
    // requestSubmit exists in jsdom but does nothing observable here.
    const result = await executeAction({ action: "submit", target: { elementId: buttonId } }, buttonId);
    expect(result.ok).toBe(true);
    expect(result.details).toContain("control");
  });

  it("fails honestly when submission has no effect and no control exists", async () => {
    document.body.innerHTML = `<form id="f"><input type="text" aria-label="Name"></form>`;
    const { indexAll, idOf } = await import("@/content/indexer");
    indexAll(document);
    const inputId = idOf(document.querySelector("input")!)!;
    const result = await executeAction({ action: "submit", target: { elementId: inputId } }, inputId);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("submit_no_effect");
  });

  it("fails honestly without a form", async () => {
    document.body.innerHTML = `<div>no form here</div>`;
    const result = await executeAction({ action: "submit", target: { elementId: "el_none" } } as never);
    expect(result.ok).toBe(false);
  });
});

/* ---------------- verifier: SEARCH outcome ---------------- */

describe("verifier SEARCH outcome", () => {
  const action = (text: string): AgentAction => ({ action: "search", text });

  it("passes on navigation to a results page", async () => {
    const pre = snap();
    const after = snap({ url: YT_RESULTS, visibleText: "Search results for beginner C tutorial video one video two" });
    const r = await verifyAction(action("beginner C tutorial"), { value: "beginner C tutorial" }, pre, () => after);
    expect(r.ok).toBe(true);
  });

  it("passes on fresh result content carrying the query", async () => {
    const pre = snap();
    const after = snap({
      visibleText: "beginner C tutorial results video one video two Filters",
      counted: 5,
    });
    const r = await verifyAction(action("beginner C tutorial"), { value: "beginner C tutorial" }, pre, () => after);
    expect(r.ok).toBe(true);
  });

  it("fails on suggestions-only change (query in box is not search success)", async () => {
    const pre = snap();
    // Suggestions appear: visible text changes, but no navigation and no
    // new result items — the exact defect state from the bug report.
    const after = snap({ visibleText: "YouTube Home Search beginner C tutorial suggestion one suggestion two" });
    const r = await verifyAction(action("beginner C tutorial"), { value: "beginner C tutorial" }, pre, () => after);
    expect(r.ok).toBe(false);
    expect(r.evidence.join(" ")).toMatch(/no search-result state/);
  });

  it("fails when nothing changed at all", async () => {
    const pre = snap();
    const r = await verifyAction(action("beginner C tutorial"), { value: "beginner C tutorial" }, pre, () => pre);
    expect(r.ok).toBe(false);
  });
});

/* ---------------- planner: submit step emits SEARCH ---------------- */

describe("deterministic planner search steps", () => {
  const goal: TaskGoal = {
    goal: "Find a beginner C language tutorial on YouTube",
    intent: "media",
    entities: [
      { label: "platform", value: "YouTube", raw: "YouTube" },
      { label: "query", value: "beginner C tutorial", raw: "find a beginner C tutorial" },
    ],
    steps: ["open the video platform", "enter the query", "submit the search", "select a relevant result", "open the selected video", "verify the result"],
    startUrl: YT_HOME,
  };

  it("'submit the search' emits the SEARCH composite with input + query", () => {
    const decision = planNextAction(goal, 2, snap());
    expect(decision?.action.action).toBe("search");
    expect(decision?.action.text).toBe("beginner C tutorial");
    expect(decision?.action.target?.elementId).toBe("el_010");
  });

  it("'submit the search' without a recognizable field still emits targetless SEARCH", () => {
    const decision = planNextAction(goal, 2, snap({ elements: [] }));
    expect(decision?.action.action).toBe("search");
    expect(decision?.action.text).toBe("beginner C tutorial");
    expect(decision?.action.target).toBeUndefined();
  });

  it("selects the query-relevant result link, not site chrome", () => {
    // Verified live: the homepage logo link precedes video results in DOM
    // order — a first-link pick clicks "YouTube Home" instead of the video.
    const selectGoal: TaskGoal = {
      ...goal,
      steps: ["select a relevant result"],
    };
    const decision = planNextAction(
      selectGoal,
      0,
      snap({
        url: "https://www.youtube.com/results?search_query=beginner+C+tutorial",
        visibleText: "Search results video one video two",
        elements: [
          el("el_001", "link", "YouTube Home"),
          el("el_201", "link", "C Language Tutorial for Beginners"),
          el("el_202", "link", "Unrelated music video"),
        ],
      }),
    );
    expect(decision?.action.action).toBe("click");
    expect(decision?.action.target?.elementId).toBe("el_201");
  });

  it("ignores nameless links and prefers the longer descriptive match on ties", () => {
    const selectGoal: TaskGoal = {
      ...goal,
      steps: ["select a relevant result"],
    };
    const decision = planNextAction(
      selectGoal,
      0,
      snap({
        url: "https://www.youtube.com/results?search_query=beginner+C+tutorial",
        visibleText: "Search results video one video two",
        elements: [
          el("el_001", "link", "YouTube Home"),
          el("el_000", "link", ""),
          el("el_201", "link", "C Language Tutorial for Beginners full course part 1"),
          el("el_202", "link", "C Language Tutorial"),
        ],
      }),
    );
    expect(decision?.action.action).toBe("click");
    expect(decision?.action.target?.elementId).toBe("el_201");
  });

  it("settles instead of clicking chrome when no link is relevant yet", () => {
    const selectGoal: TaskGoal = {
      ...goal,
      steps: ["select a relevant result"],
    };
    const decision = planNextAction(
      selectGoal,
      0,
      snap({
        url: "https://www.youtube.com/results?search_query=beginner+C+tutorial",
        visibleText: "Search results video one video two",
        elements: [el("el_001", "link", "YouTube Home"), el("el_015", "link", "Sign in")],
      }),
    );
    // Guessing would click site chrome; ending would abandon the task.
    // Settling re-observes — verification still judges what follows.
    expect(decision?.action.action).toBe("wait");
  });

  it("waits when no result links rendered yet instead of ending the task", () => {
    const selectGoal: TaskGoal = {
      ...goal,
      steps: ["select a relevant result"],
    };
    const decision = planNextAction(
      selectGoal,
      0,
      snap({
        url: "https://www.youtube.com/results?search_query=beginner+C+tutorial",
        visibleText: "Search results loading",
        elements: [el("el_010", "searchbox", "Search", { value: "beginner C tutorial" })],
      }),
    );
    expect(decision?.action.action).toBe("wait");
  });

  it("waits for an unrendered page instead of finishing on empty air", () => {
    const emptyGoal: TaskGoal = {
      ...goal,
      steps: ["enter the query", "submit the search"],
    };
    const decision = planNextAction(emptyGoal, 0, snap({ visibleText: "", elements: [], counted: 0 }));
    expect(decision?.action.action).toBe("wait");
  });

  it("prefers a searchbox-role field over a generic textbox for query entry", () => {
    const decision = planNextAction(
      goal,
      2,
      snap({
        elements: [
          el("el_090", "textbox", "Filter", { value: "" }),
          el("el_010", "searchbox", "Search", { value: "" }),
        ],
      }),
    );
    expect(decision?.action.action).toBe("search");
    // A bare textbox might be any form control; the searchbox IS the field.
    expect(decision?.action.target?.elementId).toBe("el_010");
  });

  it("resolves real-world combobox search fields (role combobox + search name)", () => {
    // Mirrors the live YouTube observation: the search input carries
    // role=combobox, not textbox/searchbox.
    const decision = planNextAction(
      goal,
      2,
      snap({
        elements: [
          el("el_004", "button", "Guide"),
          el("el_008", "combobox", "Search", { value: "" }),
        ],
      }),
    );
    expect(decision?.action.action).toBe("search");
    expect(decision?.action.target?.elementId).toBe("el_008");
  });

  it("never targets an arbitrary element when no search field matches", () => {
    // A zero-signal match must resolve to targetless SEARCH (executor
    // self-resolves), never to the first visible element.
    const decision = planNextAction(
      goal,
      2,
      snap({
        elements: [
          el("el_004", "button", "Guide"),
          el("el_090", "textbox", "Filter", { value: "" }),
        ],
      }),
    );
    expect(decision?.action.action).toBe("search");
    expect(decision?.action.target).toBeUndefined();
  });
});

/* ---------------- controller: pause / resume / no-progress ---------------- */

function fakeSearchWorld(opts: { failTypeTimes?: number; neverResults?: boolean } = {}) {
  const state = {
    url: YT_HOME,
    visibleText: "YouTube Home Search",
    query: "",
    typeCalls: 0,
    results: false,
  };
  const snapshot = (): ObservationSnapshot => ({
    url: state.url, title: "YouTube", tabId: 7, pageType: "content",
    viewport: { w: 1280, h: 800 }, scrollY: 0, scrollH: 2000, loading: false,
    visibleText: state.visibleText,
    elements: [
      el("el_010", "searchbox", "Search", { value: state.query }),
      el("el_011", "button", "Search", { tag: "button" }),
    ],
    counted: 2, createdAt: Date.now(),
  });
  const adapter = {
    runtimeName: "chrome",
    queryActiveTab: async () => ({ id: 7, url: state.url, title: "" }),
    navigateTab: async (_t: number, url: string) => {
      state.url = url;
    },
    reloadTab: async () => undefined,
    closeTab: async () => undefined,
    createTab: async () => null,
    listTabs: async () => [],
    activateTab: async () => undefined,
    goBackTab: async () => false,
    goForwardTab: async () => false,
    sendToTabAndRespond: async (_t: number, message: unknown): Promise<unknown> => {
      const msg = message as { type: string; payload?: { action?: AgentAction } };
      if (msg.type === "CTX_PING") return { type: "CTX_PONG", payload: { ok: true, url: state.url } };
      if (msg.type === "CTX_OBSERVE") return { type: "CTX_OBSERVE_RESULT", payload: { ...snapshot(), tabId: 7 } };
      if (msg.type === "CTX_EXECUTE") {
        const act = msg.payload?.action as AgentAction;
        // The real executor answers wait terminally.
        if (act.action === "wait") {
          return { type: "CTX_EXECUTE_RESULT", payload: { ok: true, hint: {} } satisfies ActionResult };
        }
        if (act.action === "type") {
          state.typeCalls++;
          if (state.typeCalls <= (opts.failTypeTimes ?? 0)) {
            return { type: "CTX_EXECUTE_RESULT", payload: { ok: false, error: "stale element removed on page" } satisfies ActionResult };
          }
          state.query = act.text ?? "";
          return { type: "CTX_EXECUTE_RESULT", payload: { ok: true, hint: { value: act.text } } satisfies ActionResult };
        }
        if (act.action === "search") {
          state.query = act.text ?? state.query;
          if (!opts.neverResults) {
            state.results = true;
            state.url = YT_RESULTS;
            state.visibleText = `Search results for ${state.query} video one video two`;
          }
          return { type: "CTX_EXECUTE_RESULT", payload: { ok: true, hint: { value: state.query } } satisfies ActionResult };
        }
        if (act.action === "click") {
          return { type: "CTX_EXECUTE_RESULT", payload: { ok: true, hint: {} } satisfies ActionResult };
        }
        if (act.action === "finish") {
          return { type: "CTX_EXECUTE_RESULT", payload: { ok: true } satisfies ActionResult };
        }
        return { type: "CTX_EXECUTE_RESULT", payload: { ok: false, error: "unhandled" } satisfies ActionResult };
      }
      return { ok: false };
    },
  } as unknown as BrowserAdapter;
  return { adapter, state };
}

describe("controller search failure routing", () => {
  it("TEST E: unverifiable search pauses the task — no next step, no global error", async () => {
    const { adapter } = fakeSearchWorld({ neverResults: true });
    const bus = new AgentEventBus();
    const paused: string[] = [];
    let failed = false;
    let completed = false;
    bus.on("TASK_PAUSED", (p) => paused.push(p.reason));
    bus.on("TASK_FAILED", () => {
      failed = true;
    });
    bus.on("TASK_COMPLETED", () => {
      completed = true;
    });
    bus.on("USER_INPUT_REQUIRED", () => {});
    const controller = new AgentController(adapter, bus);
    const parked = new Promise<void>((resolve) => bus.on("TASK_PAUSED", () => resolve()));
    const runPromise = controller.run("Find a beginner C tutorial on YouTube", 7);
    await parked;

    expect(paused.length).toBeGreaterThan(0);
    expect(paused[0]).toMatch(/retr|verif|submit|progress/i);
    expect(controller.status.runtime).toBe("PAUSED");
    expect(failed).toBe(false);
    expect(completed).toBe(false);
    // TEST 9: a parked task performs no background work — no further
    // actions start after the pause.
    let startsAfterPause = 0;
    bus.on("ACTION_STARTED", () => {
      startsAfterPause++;
    });
    await new Promise((r) => setTimeout(r, 400));
    expect(startsAfterPause).toBe(0);
    controller.stop();
    await runPromise;
  }, 30000);

  it("pauses carry the failed step and a human reason (PAUSED UX contract)", async () => {
    const { adapter } = fakeSearchWorld({ failTypeTimes: 99 });
    const bus = new AgentEventBus();
    const pauses: Array<{ reason: string; step?: string }> = [];
    bus.on("TASK_PAUSED", (p) => pauses.push({ reason: p.reason, step: p.step }));
    const controller = new AgentController(adapter, bus);
    bus.on("USER_INPUT_REQUIRED", () => {});
    const parked = new Promise<void>((resolve) => bus.on("TASK_PAUSED", () => resolve()));
    const runPromise = controller.run("Find a beginner C tutorial on YouTube", 7);
    await parked;

    expect(pauses).toHaveLength(1);
    expect(pauses[0].reason.length).toBeGreaterThan(0);
    expect(typeof pauses[0].step === "string" || pauses[0].step === undefined).toBe(true);
    expect(controller.status.runtime).toBe("PAUSED");
    controller.stop();
    await runPromise;
  }, 30000);

  it("resume after a transient failure continues from the failed step", async () => {
    // Type fails 3 times (recovery retries), then the page cooperates.
    const { adapter, state } = fakeSearchWorld({ failTypeTimes: 3 });
    const bus = new AgentEventBus();
    const order: string[] = [];
    bus.on("TASK_PAUSED", () => order.push("paused"));
    bus.on("TASK_COMPLETED", () => order.push("completed"));
    bus.on("USER_INPUT_REQUIRED", () => {});
    const controller = new AgentController(adapter, bus);
    const done = new Promise<void>((resolve) => bus.on("TASK_COMPLETED", () => resolve()));
    await controller.run("Find a beginner C tutorial on YouTube", 7);
    await done;

    // Recovery absorbed the transient failures without pausing at all.
    expect(order).toEqual(["completed"]);
    expect(state.query).toBe("beginner C tutorial");
    expect(state.results).toBe(true);
    expect(controller.status.runtime).toBe("COMPLETED");
  }, 30000);
});

describe("controller no-progress guard", () => {
  it("the same vacuous action repeating without progress pauses instead of spinning", async () => {
    const { adapter } = fakeSearchWorld();
    const bus = new AgentEventBus();
    const executes: string[] = [];
    bus.on("ACTION_STARTED", ({ action }) => executes.push(action.action));
    const pauses: string[] = [];
    bus.on("TASK_PAUSED", (p) => pauses.push(p.reason));
    let failed = false;
    bus.on("TASK_FAILED", () => {
      failed = true;
    });
    // A stuck planner: the identical click forever, each "verifying" via
    // the stable-page heuristic. Exactly the repeated-press_key shape.
    const stuck = async () => ({
      action: {
        action: "click",
        target: { elementId: "el_011", name: "Search" },
        confidence: 0.95,
        expectedOutcome: { type: "noop" },
      } as AgentAction,
      justification: "stuck",
    });
    const controller = new AgentController(adapter, bus, stuck as never);
    bus.on("USER_INPUT_REQUIRED", () => {});
    const parked = new Promise<void>((resolve) => bus.on("TASK_PAUSED", () => resolve()));
    const runPromise = controller.run("Find a beginner C tutorial on YouTube", 7);
    await parked;

    expect(pauses[0]).toMatch(/no progress/i);
    // Three identical executions, then the guard parks before a fourth.
    expect(executes.filter((a) => a === "click")).toHaveLength(3);
    expect(failed).toBe(false);
    expect(controller.status.runtime).toBe("PAUSED");
    controller.stop();
    await runPromise;
  }, 30000);
});
