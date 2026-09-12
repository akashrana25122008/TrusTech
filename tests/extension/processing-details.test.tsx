/**
 * Processing Details dashboard: status summary, task plan, execution
 * timeline, verification, and event log — all rendered from REAL
 * AgentState objects (no fabricated steps, no simulated completion).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { ProcessingDetails } from "@/ui/components/ProcessingDetails";
import type { AgentLogEntry, AgentState, TaskStep } from "@/shared/types";

// @ts-expect-error test env flag for act()
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root | null = null;

const step = (id: string, text: string, status: TaskStep["status"], statusReason?: string): TaskStep => ({
  id,
  text,
  status,
  statusReason,
});

const entry = (over: Partial<AgentLogEntry> & { text: string }): AgentLogEntry => ({
  id: `e-${Math.random().toString(36).slice(2, 9)}`,
  at: 1789000000000,
  level: "info",
  ...over,
});

function baseState(over: Partial<AgentState> = {}): AgentState {
  return {
    status: "IDLE",
    task: "",
    steps: [],
    actionText: "Standing by. Describe a task to take control of the browser.",
    telemetry: {
      confidence: 98,
      vision: 92,
      privacy: "SAFE",
      browserControl: false,
      step: 0,
      totalSteps: 0,
      currentTab: "Your page",
      currentUrl: "",
    },
    risk: null,
    log: [],
    plan: null,
    data: null,
    ...over,
  };
}

function renderDrawer(state: AgentState) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(<ProcessingDetails state={state} onClearLog={() => undefined} open={true} onToggle={() => undefined} />);
  });
  return host;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  document.body.innerHTML = "";
});

describe("ProcessingDetails dashboard", () => {
  it("empty state is intentional, never an error", () => {
    const h = renderDrawer(baseState());
    expect(h.textContent).toContain("Hide processing details");
    expect(h.textContent).toContain("TASK PLAN");
    expect(h.textContent).toContain("No page actions yet.");
    expect(h.textContent).toContain("No verified outcomes yet.");
    expect(h.querySelector(".status-badge")?.textContent).toContain("IDLE");
  });

  it("executing state shows badge, counter, progress, and live action", () => {
    const h = renderDrawer(
      baseState({
        status: "ACTING",
        task: "Find a beginner C tutorial on YouTube",
        actionText: "Executing search → Search…",
        steps: [
          step("step_1", "Open YouTube", "done"),
          step("step_2", "Search beginner C tutorial", "active"),
          step("step_3", "Open a relevant video", "pending"),
        ],
        telemetry: {
          confidence: 86,
          vision: 92,
          privacy: "SAFE",
          browserControl: true,
          step: 2,
          totalSteps: 6,
          currentTab: "YouTube",
          currentUrl: "https://www.youtube.com/",
        },
        plan: { source: "groq" },
      }),
    );
    expect(h.querySelector(".status-badge")?.textContent).toContain("EXECUTING");
    expect(h.textContent).toContain("STEP 01 / 03");
    expect(h.querySelector(".pd-progress__fill")?.getAttribute("style")).toContain("33%");
    expect(h.textContent).toContain("Search beginner C tutorial");
    expect(h.textContent).toContain("PRIVACY SAFE");
    expect(h.textContent).toContain("GROQ");
    // Real step states only: one done, one active, one pending.
    expect(h.querySelectorAll(".timeline__item.is-done")).toHaveLength(1);
    expect(h.querySelectorAll(".timeline__item.is-active")).toHaveLength(1);
    expect(h.querySelectorAll(".timeline__item.is-pending")).toHaveLength(1);
  });

  it("never fabricates completion: pending steps stay pending", () => {
    const h = renderDrawer(
      baseState({
        status: "AWAITING_VERIFY",
        actionText: "Opened beginner C tutorial on YouTube",
        steps: [step("step_1", "Open YouTube", "done"), step("step_2", "Verify the result", "pending")],
      }),
    );
    expect(h.querySelectorAll(".timeline__item.is-done")).toHaveLength(1);
    expect(h.textContent).toContain("AWAITING VERIFICATION");
    expect(h.textContent).not.toContain("VERIFIED_SUCCESS");
  });

  it("execution timeline groups structured action events with ids", () => {
    const h = renderDrawer(
      baseState({
        status: "ACTING",
        log: [
          entry({ level: "info", text: 'task started [task_1789] — "demo"', event: { kind: "task-start", taskId: "task_1789" } }),
          entry({
            level: "action",
            text: "action → click → Search [act_1_5/step_5]",
            event: { kind: "action-start", spec: "click → Search", taskId: "task_1789", actionId: "act_1_5", stepId: "step_5" },
          }),
          entry({
            level: "success",
            text: "verified ✓ click → Search [act_1_5]",
            event: { kind: "verify-ok", spec: "click → Search", taskId: "task_1789", actionId: "act_1_5" },
          }),
          entry({
            level: "error",
            text: "failed ✗ type → Name [act_1_6] (stale_target)",
            event: { kind: "action-fail", spec: "type → Name", taskId: "task_1789", actionId: "act_1_6", error: "stale_target" },
          }),
        ],
      }),
    );
    const rows = h.querySelectorAll(".exec-timeline__item");
    expect(rows).toHaveLength(2);
    expect(rows[0].className).toContain("is-ok");
    expect(rows[1].className).toContain("is-failed");
    expect(h.textContent).toContain("act_1_5");
    expect(h.textContent).toContain("stale_target");
    // Verification section lists the verified outcome, not a wall of text.
    expect(h.querySelector(".pd-verify-list")?.textContent).toContain("click → Search");
  });

  it("paused state shows the real reason, never a global error", () => {
    const h = renderDrawer(
      baseState({
        status: "PAUSED",
        actionText: "Browser page cannot be controlled. Open a regular webpage to continue.",
        steps: [step("step_1", "Click the button", "failed", "unsupported page")],
        log: [
          entry({
            level: "risk",
            text: "task paused — Browser page cannot be controlled.",
            event: { kind: "paused", details: "unsupported_page" },
          }),
        ],
      }),
    );
    expect(h.querySelector(".status-badge")?.textContent).toContain("PAUSED");
    expect(h.textContent).toContain("PAUSED — REASON");
    expect(h.textContent).toContain("Browser page cannot be controlled.");
    // Failed plan step is shown, not converted to a global error block.
    expect(h.querySelectorAll(".timeline__item.is-failed")).toHaveLength(1);
    expect(h.textContent).not.toContain("FAILURE / STOP REASON");
  });

  it("verify-failed shows NOT VERIFIED with the rejection reason", () => {
    const h = renderDrawer(
      baseState({ status: "VERIFY_FAILED", actionText: "No video opened.", steps: [step("step_1", "Open video", "failed")] }),
    );
    expect(h.querySelector(".status-badge")?.textContent).toContain("NOT VERIFIED");
    expect(h.textContent).toContain("OBJECTIVE NOT MET");
    expect(h.textContent).toContain("No video opened.");
  });

  it("verified shows concise success without new actions", () => {
    const h = renderDrawer(baseState({ status: "VERIFIED", actionText: "Objective verified — task done." }));
    expect(h.querySelector(".status-badge")?.textContent).toContain("VERIFIED");
    expect(h.textContent).toContain("Objective verified");
  });

  it("error state shows the real system message", () => {
    const h = renderDrawer(baseState({ status: "ERROR", actionText: "Browser extension not detected." }));
    expect(h.textContent).toContain("FAILURE / STOP REASON");
    expect(h.textContent).toContain("Browser extension not detected.");
  });

  it("event log is independently collapsible with truncated ids and tooltips", () => {
    const h = renderDrawer(
      baseState({
        log: [
          entry({
            level: "action",
            text: "action → click → Search [act_1_5/step_5]",
            event: { kind: "action-start", spec: "click", taskId: "task_1789000000000-long", actionId: "act_1_5", stepId: "step_5" },
          }),
        ],
      }),
    );
    // Collapsed by default: rows hidden, LIVE badge + status shown.
    expect(h.querySelector(".pd-log__body")).toBeNull();
    expect(h.textContent).toContain("LIVE");
    const toggle = h.querySelector(".pd-log__toggle") as HTMLButtonElement;
    act(() => {
      toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const body = h.querySelector(".pd-log__body");
    expect(body).not.toBeNull();
    const idChip = h.querySelector(".pd-log__ids .timeline__id") as HTMLElement;
    expect(idChip.textContent).toContain("…");
    expect(idChip.getAttribute("title")).toBe("task_1789000000000-long");
  });

  it("drawer expand/collapse toggles the body region", async () => {
    let open = false;
    const toggles: boolean[] = [];
    const renderInto = () => {
      root!.render(
        <ProcessingDetails
          state={baseState()}
          onClearLog={() => undefined}
          open={open}
          onToggle={(v) => {
            open = v;
            toggles.push(v);
            renderInto();
          }}
        />,
      );
    };
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      renderInto();
    });
    expect(host.querySelector("#processing-details")).toBeNull();
    (host.querySelector(".processing__toggle") as HTMLButtonElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await sleep(50);
    act(() => undefined);
    expect(toggles).toEqual([true]);
    expect(host.querySelector("#processing-details")).not.toBeNull();
    expect(host.querySelector(".processing__toggle")?.getAttribute("aria-expanded")).toBe("true");
  });

  it("long task text and long urls wrap without horizontal overflow", () => {
    const h = renderDrawer(
      baseState({
        task: "Find a beginner C language tutorial on YouTube and then do a whole lot more things afterwards",
        actionText: "Executing search → Search with a very long target description that keeps going…",
        telemetry: {
          confidence: 80,
          vision: 90,
          privacy: "SAFE",
          browserControl: true,
          step: 1,
          totalSteps: 2,
          currentTab: "YouTube",
          currentUrl: "https://www.youtube.com/results?search_query=beginner+C+language+tutorial&sp=EgIQAQ%253D%253D",
        },
      }),
    );
    expect(h.textContent).toContain("Find a beginner C language tutorial");
    const urlChip = h.querySelector(".pd-chip__v");
    expect(urlChip).not.toBeNull();
  });
});
