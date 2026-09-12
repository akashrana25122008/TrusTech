import { useCallback, useEffect, useRef, useState } from "react";
import { INITIAL_STATE, type AgentLogEntry, type AgentState, type AgentStateKey, type HighlightKind, type TaskStep } from "@/shared/types";
import { RUNTIME_TO_UI_STATUS, type AgentRuntimeStatus } from "@/agent/state-manager";
import { AgentEventBus } from "@/shared/event-bus";
import { AgentController } from "@/agent/controller";
import { GatewayLlmProvider } from "@/llm/gateway-provider";
import { buildLlmPlanner } from "@/agent/llm-planner";
import { ChromeStorageBackend, VisualMemoryStore } from "@/agent/memory-store";
import { PanelTransportAdapter } from "@/browser/panel";
import { buildGuardedTimeline, type GuardedStep } from "@/agent/controller";

/* ------------------------------------------------------------------ *
 * Agent state hook — two feeding paths:
 *   1. Live: AgentController over the PanelTransportAdapter (real
 *      extension context). Events flow over the typed event bus.
 *   2. Fallback: the guarded simulator timeline (vite dev / no API),
 *      so the panel and robot remain fully interactive offline.
 * ------------------------------------------------------------------ */

type Events = {
  pushState(status: AgentStateKey, actionText: string): void;
  highlight(kind: HighlightKind, label: string, selector?: string): void;
  beam(on: boolean, selector?: string): void;
};

const uid = () => Math.random().toString(36).slice(2, 9);

/** Append a line to the in-panel debug console. */
function appendLog(entry: Omit<AgentLogEntry, "id" | "at">): (prev: AgentState) => AgentState {
  return (prev) => ({
    ...prev,
    log: [...prev.log.slice(-199), { id: uid(), at: Date.now(), ...entry }],
  });
}

// Module-level singletons so repeated mounts share one runtime session.
const transport = new PanelTransportAdapter();
const bus = new AgentEventBus();
const gatewayProvider = new GatewayLlmProvider();
const planner = buildLlmPlanner(gatewayProvider);
// Cross-session visual memory (Feature #5): chrome.storage.local when
// available, silent in-memory fallback otherwise. Never blocks tasks.
const memoryStore = new VisualMemoryStore(new ChromeStorageBackend());
const controller = new AgentController(transport, bus, planner, memoryStore);

const RUNTIME_LABEL: Partial<Record<AgentRuntimeStatus, string>> = {
  UNDERSTANDING: "Understanding the task…",
  OBSERVING: "Observing the page…",
  PLANNING: "Planning the next step…",
  VALIDATING: "Validating intention…",
  ACTING: "Executing in the page…",
  VERIFYING: "Verifying the outcome…",
  RECOVERY: "Recovering from a failed step…",
  COMPLETED: "Task complete.",
  FAILED: "Task failed.",
};

function describeAction(rt: AgentRuntimeStatus): string {
  return RUNTIME_LABEL[rt] ?? "Working…";
}

export function useAgentState(bridge?: Events) {
  const [state, setState] = useState<AgentState>(INITIAL_STATE);
  const timeouts = useRef<Array<number>>([]);
  const pending = useRef<GuardedStep[]>([]);
  const gateAt = useRef(0);
  const taskSteps = useRef<TaskStep[]>([]);
  const stepIndex = useRef(0);
  const controllerActive = useRef(false);
  /** Pending bound-approval action id (mirrors risk.actionId). */
  const pendingActionId = useRef<string | undefined>(undefined);

  const pushState = useCallback(
    (status: AgentStateKey, actionText: string) => bridge?.pushState(status, actionText),
    [bridge],
  );

  const clearScheduled = useCallback(() => {
    timeouts.current.forEach((t) => window.clearTimeout(t));
    timeouts.current = [];
  }, []);

  /* ---------- live controller path ---------- */

  useEffect(() => {
    const offs: Array<() => void> = [];

    offs.push(
      bus.on("STATUS_CHANGED", ({ status }) => {
        const ui = RUNTIME_TO_UI_STATUS[status];
        setState((prev) => {
          // Post-completion UI states belong to the verification flow:
          // a trailing COMPLETED must not clobber AWAITING_VERIFY (and its
          // execution result) back into a bare status line.
          if (prev.status === "AWAITING_VERIFY" || prev.status === "VERIFIED" || prev.status === "VERIFY_FAILED") {
            return prev;
          }
          return {
            ...prev,
            status: ui,
            actionText: describeAction(status),
          };
        });
      }),
    );

    offs.push(
      bus.on("TASK_STARTED", ({ taskId, goal }) => {
        setState(
          appendLog({
            level: "info",
            text: `task started [${taskId}] — "${goal.slice(0, 120)}"`,
            event: { kind: "task-start", taskId },
          }),
        );
      }),
    );

    offs.push(
      bus.on("ACTION_STARTED", ({ action, actionId, stepId, taskId }) => {
        setState((prev) => ({
          ...prev,
          status: "ACTING",
          actionText: `Executing ${describeActionSpec(action)}…`,
        }));
        pushState("ACTING", `Executing ${describeActionSpec(action)}…`);
        setState(
          appendLog({
            level: "action",
            text: `action → ${describeActionSpec(action)} [${actionId}${stepId ? `/${stepId}` : ""}]`,
            event: { kind: "action-start", spec: describeActionSpec(action), taskId, actionId, stepId },
          }),
        );
      }),
    );

    offs.push(
      bus.on("PLAN_CHANGED", ({ steps, meta, data }) => {
        // The controller is the single writer of the timeline; mirror it
        // verbatim (this is THE plan driving the run). Structured task data
        // rides along; once set it is never cleared by a data-less emit.
        setState((prev) => {
          const doneCount = steps.filter((s) => s.status === "done").length;
          return {
            ...prev,
            steps,
            plan: meta,
            data: data != null ? data : prev.data ?? null,
            telemetry: {
              ...prev.telemetry,
              totalSteps: steps.length,
              step: Math.min(Math.max(doneCount + 1, 1), Math.max(steps.length, 1)),
            },
          };
        });
      }),
    );

    offs.push(
      bus.on("VERIFICATION_SUCCEEDED", ({ action, actionId, taskId }) => {
        setState((prev) => ({
          ...prev,
          status: "THINKING",
          actionText: `Done: ${describeActionSpec(action)}`,
        }));
        pushState("THINKING", `Done: ${describeActionSpec(action)}`);
        setState(
          appendLog({
            level: "success",
            text: `verified ✓ ${describeActionSpec(action)} [${actionId}]`,
            event: { kind: "verify-ok", spec: describeActionSpec(action), taskId, actionId },
          }),
        );
      }),
    );

    offs.push(
      bus.on("VERIFICATION_FAILED", ({ action, evidence, actionId, taskId }) => {
        setState(
          appendLog({
            level: "error",
            text: `verification ✗ ${describeActionSpec(action)} [${actionId}]: ${evidence.join("; ").slice(0, 160)}`,
            event: {
              kind: "verify-fail",
              spec: describeActionSpec(action),
              taskId,
              actionId,
              evidence,
            },
          }),
        );
      }),
    );

    offs.push(
      bus.on("ACTION_FAILED", ({ action, error, details, actionId, taskId }) => {
        setState(
          appendLog({
            level: "error",
            text: `failed ✗ ${describeActionSpec(action)} [${actionId}] (${error}${details ? ` — ${details}` : ""})`,
            event: {
              kind: "action-fail",
              spec: describeActionSpec(action),
              taskId,
              actionId,
              error,
              details,
            },
          }),
        );
      }),
    );

    offs.push(
      bus.on("RECOVERY_ATTEMPT", ({ attempt, strategy, reason, action }) => {
        setState(
          appendLog({
            level: "info",
            text: `recovery #${attempt} (${strategy}${action ? ` ${action}` : ""}): ${reason}`,
            event: { kind: "recovery", spec: action, attempt, strategy },
          }),
        );
      }),
    );

    offs.push(
      bus.on("PROVIDER_FALLBACK", ({ provider, stage, error, code, retryable }) => {
        const tag = code ? ` [${code}${retryable ? ", retryable" : ""}]` : "";
        setState(
          appendLog({
            level: "info",
            text: `reasoning fallback — ${provider} ${stage}${error ? `: ${error}` : ""}${tag}; local planner active`,
          }),
        );
      }),
    );

    offs.push(
      bus.on("FIREWALL_DECISION", ({ decision, reason, detectedTypes, redactionCount }) => {
        // Metadata only — types, reasons and counts, never values.
        const detail =
          decision === "ALLOW"
            ? `firewall ${reason}: ${redactionCount} redacted (${detectedTypes.join(",") || "none"}) — rescan clean`
            : `firewall BLOCKED: ${reason} (${detectedTypes.join(",") || "none"}) — nothing transmitted`;
        setState(appendLog({ level: decision === "ALLOW" ? "info" : "risk", text: detail }));
      }),
    );

    offs.push(
      bus.on("USER_INPUT_REQUIRED", ({ reason, actionId, actionLabel, riskLevel, confidence }) => {
        // Bound confirmation: the UI approves exactly this action
        // instance; the controller re-validates page + target first.
        pendingActionId.current = actionId;
        const label = actionLabel
          ? `Approve: ${actionLabel} (risk ${riskLevel ?? "?"}, confidence ${confidence != null ? Math.round(confidence * 100) : "?"}%)`
          : "Action requires confirmation";
        setState((prev) => ({
          ...prev,
          status: "WAITING",
          actionText: "Waiting for your confirmation…",
          risk: { label, reasons: [reason], level: "high", actionId, actionLabel, riskLevel, confidence },
        }));
        pushState("WAITING", "Waiting for your confirmation…");
        setState(appendLog({ level: "risk", text: `holds for consent: ${reason}` }));
      }),
    );

    offs.push(
      bus.on("SAFETY_DECIDED", ({ actionId, decision, confidence, risk, target, reasons }) => {
        // Metadata only — ids, scores and generic reasons, never values.
        setState(
          appendLog({
            level: decision === "BLOCK" ? "error" : "info",
            text: `safety ${decision} ${actionId} (conf ${Math.round(confidence * 100)}%, risk ${risk}, target ${target}): ${reasons.join("; ")}`,
          }),
        );
      }),
    );

    offs.push(
      bus.on("APPROVAL_INVALIDATED", ({ actionId, reason }) => {
        setState(appendLog({ level: "risk", text: `approval ${actionId} invalidated: ${reason}` }));
      }),
    );

    offs.push(
      bus.on("DRIFT_EVENT", ({ phase, decision, severity, driftScore, driftTypes, reasons }) => {
        // Metadata only — scores, types and generic reasons, never values.
        setState(
          appendLog({
            level: decision === "ABORT" ? "error" : "risk",
            text: `drift [${phase}] ${severity} (score ${driftScore}, ${driftTypes.join(",") || "none"}): ${reasons.join("; ")} → ${decision}`,
          }),
        );
      }),
    );

    offs.push(
      bus.on("TRUST_EVENT", ({ score, level, decision, signals, reasons }) => {
        // Metadata only — score, level, decision, reason codes.
        setState((prev) => ({
          ...prev,
          telemetry: { ...prev.telemetry, trust: { score, level } },
        }));
        setState(
          appendLog({
            level: decision === "BLOCK" ? "error" : decision === "PAUSE" ? "risk" : "info",
            text: `trust ${score}/100 ${level} → ${decision} (${signals.join(",") || "none"}${reasons.length > 0 ? `; ${reasons.join("; ")}` : ""})`,
          }),
        );
      }),
    );

    offs.push(
      bus.on("TASK_COMPLETED", ({ result }) => {
        // EXECUTION-complete, not objective-complete: every planned browser
        // action ran with successful results, but the OBJECTIVE is unverified
        // until the user inspects the real page. The timeline is owned by
        // the controller — never bulk-marked done here.
        pendingActionId.current = undefined;
        setState((prev) => ({
          ...prev,
          status: "AWAITING_VERIFY",
          actionText: result ?? "Execution finished.",
          risk: null,
        }));
        pushState("AWAITING_VERIFY", result ?? "Execution finished.");
        bridge?.beam(true);
        setState(
          appendLog({
            level: "success",
            text: `execution complete — awaiting your verification: ${result ?? ""}`,
            event: { kind: "task-done" },
          }),
        );
      }),
    );

    offs.push(
      bus.on("TASK_VERIFIED", ({ ok, note }) => {
        controllerActive.current = false;
        if (ok) {
          setState((prev) => ({
            ...prev,
            status: "VERIFIED",
            actionText: "Objective verified — task done.",
            risk: null,
          }));
          pushState("VERIFIED", "Objective verified — task done.");
          setState(
            appendLog({ level: "success", text: "objective verified by user — VERIFIED_SUCCESS", event: { kind: "verified", ok: true } }),
          );
        } else {
          const detail = note ?? "The executed actions did not accomplish the objective.";
          setState((prev) => ({
            ...prev,
            status: "VERIFY_FAILED",
            actionText: detail,
            risk: null,
          }));
          pushState("VERIFY_FAILED", detail);
          setState(
            appendLog({
              level: "error",
              text: `objective rejected by user — VERIFIED_FAILED: ${detail}`,
              event: { kind: "verified", ok: false, details: detail },
            }),
          );
        }
      }),
    );

    offs.push(
      bus.on("TASK_FAILED", ({ reason }) => {
        controllerActive.current = false;
        pendingActionId.current = undefined;
        setState((prev) => ({
          ...prev,
          status: "ERROR",
          actionText: reason,
        }));
        pushState("ERROR", reason);
        setState(appendLog({ level: "error", text: `task failed — ${reason}` }));
      }),
    );

    offs.push(
      bus.on("TASK_PAUSED", ({ reason, step, technical }) => {
        // Ordinary execution failures park here — PAUSED in the task UI
        // with the human reason up front and diagnostics in the drawer.
        // The controller loop stays alive (parked, no timers) so Resume
        // continues from the failed step; Stop still terminates it.
        pendingActionId.current = undefined;
        setState((prev) => ({
          ...prev,
          status: "PAUSED",
          actionText: reason,
        }));
        pushState("PAUSED", reason);
        setState(
          appendLog({
            level: "risk",
            text: `task paused — ${reason}${step ? ` (step: ${step})` : ""}${technical ? ` — ${technical}` : ""}`,
            event: { kind: "paused", details: technical },
          }),
        );
      }),
    );

    offs.push(
      bus.on("TASK_RESUMED", () => {
        setState(appendLog({ level: "info", text: "task resumed — re-observing the page…" }));
      }),
    );

    offs.push(
      bus.on("OBSERVATION_UPDATED", ({ snapshot }) => {
        setState((prev) => ({
          ...prev,
          telemetry: {
            ...prev.telemetry,
            currentUrl: snapshot.url,
            currentTab: snapshot.title || prev.telemetry.currentTab,
          },
        }));
      }),
    );

    offs.push(
      bus.on("PAGE_NOT_CONTROLLABLE", ({ url }) => {
        // Informational only — the controller navigates away to a scriptable
        // page instead of failing. Never a terminal state by itself.
        setState(
          appendLog({
            level: "info",
            text: `current page ${url || "internal page"} exposes no webpage controls — navigating to the requested site…`,
          }),
        );
      }),
    );

    return () => offs.forEach((off) => off());
  }, [bridge, pushState]);

  /* ---------- simulator fallback path (kept from v1) ---------- */

  const applyEvent = useCallback(
    (step: GuardedStep) => {
      const event = step.event;
      setState((prev) => {
        const nextTelemetry = {
          ...prev.telemetry,
          step: event.step ?? prev.telemetry.step,
          confidence: event.confidence ?? prev.telemetry.confidence,
          privacy: event.privacy ?? prev.telemetry.privacy,
          browserControl: event.browserControl ?? prev.telemetry.browserControl,
          currentTab: event.currentTab ?? prev.telemetry.currentTab,
          currentUrl: event.currentUrl ?? prev.telemetry.currentUrl,
          redacted: event.redacted ?? prev.telemetry.redacted ?? 0,
        };
        return {
          ...prev,
          status: event.status,
          actionText: event.actionText,
          telemetry: nextTelemetry,
          steps: event.step ? applyStepStatus(taskSteps.current, event.step) : prev.steps,
          risk: null,
        };
      });

      pushState(event.status, event.actionText);
      if (event.highlight && event.highlight.kind !== "clear") {
        bridge?.highlight(event.highlight.kind, event.highlight.label, event.highlight.selector);
        if (event.status === "ACTING") bridge?.beam(true, event.highlight.selector);
      }
      if (event.status === "SUCCESS") bridge?.beam(true);
    },
    [bridge, pushState],
  );

  const applyGate = useCallback(
    (step: GuardedStep) => {
      gateAt.current = performance.now();
      setState((prev) => ({
        ...prev,
        status: "WAITING",
        actionText: step.event.actionText,
        risk: step.hold ?? prev.risk,
      }));
      pushState("WAITING", step.event.actionText);
      setState(appendLog({ level: "risk", text: `simulator holds for consent: ${step.event.actionText}` }));
    },
    [pushState],
  );

  const schedule = useCallback(
    (steps: GuardedStep[], labels: string[]) => {
      taskSteps.current = labels.map((text, i) => ({
        id: uid(),
        text,
        status: i === 0 ? "active" : "pending",
      }));
      const started = performance.now();
      for (const step of steps) {
        const delay = Math.max(0, step.event.at - (performance.now() - started) + 1);
        timeouts.current.push(
          window.setTimeout(() => applyEvent(step), delay),
        );
      }
      return taskSteps.current;
    },
    [applyEvent],
  );

  const scheduleDeferred = useCallback(
    (steps: GuardedStep[]) => {
      const started = performance.now();
      for (const step of steps) {
        const delay = Math.max(60, step.event.at - gateAt.current + (performance.now() - started));
        timeouts.current.push(window.setTimeout(() => applyEvent(step), delay));
      }
    },
    [applyEvent],
  );

  /* ---------- public API ---------- */

  const startTask = useCallback(
    (task: string) => {
      clearScheduled();
      pending.current = [];
      gateAt.current = 0;
      stepIndex.current = 0;
      setState(appendLog({ level: "info", text: `task received — "${task}"` }));

      if (transport.ready) {
        // Live path — start in THINKING; the controller transitions to
        // OBSERVING only after a successful CTX_PING handshake. The Action
        // Timeline is seeded by the controller's PLAN_CHANGED event (the real
        // Groq plan, or the labeled local fallback) — never a local heuristic.
        controllerActive.current = true;
        taskSteps.current = [];
        setState((prev) => ({
          ...prev,
          status: "THINKING",
          task,
          actionText: "Connecting to the browser…",
          steps: [],
          plan: null,
          data: null,
          telemetry: {
            ...prev.telemetry,
            step: 1,
            totalSteps: 0,
            browserControl: true,
            redacted: 0,
          },
          risk: null,
        }));
        pushState("THINKING", "Connecting to the browser…");
        void transport.queryActiveTab().then((tab) => {
          if (tab?.id != null) {
            void controller.run(task, tab.id).catch(() => {
              controllerActive.current = false;
              setState((prev) => ({ ...prev, status: "ERROR", actionText: "Agent runtime failed to start." }));
            });
          } else {
            controllerActive.current = false;
            setState((prev) => ({
              ...prev,
              status: "ERROR",
              actionText: "Browser page cannot be controlled. Open a regular webpage to continue.",
            }));
          }
        });
        return;
      }

      // Simulator fallback.
      const timeline = buildGuardedTimeline(task);
      const taskStepsBuilt = schedule(timeline.runNow, timeline.labels);
      setState((prev) => ({
        ...prev,
        status: "OBSERVING",
        task,
        actionText: "Simulation mode — no browser API available.",
        steps: taskStepsBuilt,
        plan: { source: "local" },
        telemetry: {
          ...prev.telemetry,
          step: 1,
          totalSteps: timeline.labels.length,
          browserControl: true,
          redacted: timeline.privacy.redactedFields,
          privacy: timeline.privacy.redactedFields > 0 ? "SCANNING" : "SAFE",
        },
        risk: null,
      }));
      pushState("OBSERVING", "Simulation mode — no browser API available.");

      pending.current = timeline.deferred;
      if (timeline.gate) {
        timeouts.current.push(
          window.setTimeout(() => applyGate(timeline.gate!), Math.max(1, timeline.gate.event.at)),
        );
      }
    },
    [applyGate, clearScheduled, pushState, schedule],
  );

  const stop = useCallback(() => {
    clearScheduled();
    pending.current = [];
    gateAt.current = 0;
    taskSteps.current = [];
    stepIndex.current = 0;
    // Terminate the live controller loop too: without this the closed loop
    // keeps observing/planning/executing after the UI has reset, and a
    // subsequent task would run two loops on one controller.
    if (controllerActive.current) {
      controllerActive.current = false;
      pendingActionId.current = undefined;
      controller.stop();
    }
    setState({ ...INITIAL_STATE, risk: null });
    pushState("IDLE", INITIAL_STATE.actionText);
  }, [clearScheduled, pushState]);

  const pause = useCallback(() => {
    if (controllerActive.current) {
      controller.pause();
    }
    clearScheduled();
    setState((prev) =>
      prev.status === "AWAITING_VERIFY" || prev.status === "VERIFIED" || prev.status === "VERIFY_FAILED"
        ? prev
        : { ...prev, status: "PAUSED", actionText: "Agent paused — press resume to continue." },
    );
    pushState("PAUSED", "Agent paused — press resume to continue.");
  }, [clearScheduled, pushState]);

  const resume = useCallback(() => {
    if (controllerActive.current) {
      controller.resume();
      // Bound approval: approve exactly the pending action instance.
      controller.confirm(pendingActionId.current);
      pendingActionId.current = undefined;
      setState((prev) => ({ ...prev, status: "THINKING", actionText: "Approved — continuing…", risk: null }));
      pushState("THINKING", "Approved — continuing…");
      return;
    }
    if (pending.current.length === 0) {
      setState((prev) => ({ ...prev, status: "SUCCESS", actionText: "Task complete.", risk: null }));
      pushState("SUCCESS", "Task complete.");
      setState(appendLog({ level: "success", text: "simulator task complete" }));
      return;
    }
    const pendingSteps = [...pending.current];
    pending.current = [];
    setState((prev) => ({ ...prev, status: "THINKING", actionText: "Approved — continuing…", risk: null }));
    pushState("THINKING", "Approved — continuing…");
    scheduleDeferred(pendingSteps);
  }, [pushState, scheduleDeferred]);

  const setStatus = useCallback((status: AgentStateKey) => {
    setState((prev) => ({ ...prev, status }));
  }, []);

  const clearLog = useCallback(() => {
    setState((prev) => ({ ...prev, log: [] }));
  }, []);

  /**
   * Manual objective verification (Phase 17): the user inspected the real
   * page after execution-complete and judges the OBJECTIVE. Forwards to
   * the controller, which accepts it only in the awaiting state.
   */
  const verifyObjective = useCallback(
    (ok: boolean, note?: string) => {
      controller.submitVerification(ok, note);
    },
    [],
  );

  return {
    state,
    startTask,
    stop,
    pause,
    resume,
    verifyObjective,
    setStatus,
    clearLog,
  };
}

import type { AgentAction } from "@/shared/action-schema";

/** Human-readable action label for transient status text. */
function describeActionSpec(action: AgentAction): string {
  const name = action?.action ?? "step";
  const target = action?.target?.name ?? action?.text ?? action?.url;
  return `${name}${target ? ` → ${target}` : ""}`;
}

function applyStepStatus(steps: TaskStep[], activeStep: number): TaskStep[] {
  return steps.map((s, i) => ({
    ...s,
    status: i + 1 < activeStep ? "done" : i + 1 === activeStep ? "active" : "pending",
  }));
}