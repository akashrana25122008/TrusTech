/* ------------------------------------------------------------------ *
 * AgentController — the closed-loop runtime. Orchestrates observe →
 * plan → validate → risk-check → (confirm) → act → verify → recover.
 * The LLM or deterministic planner fills in the plan step; everything
 * else is guard-rails and reality checks.
 * ------------------------------------------------------------------ */

import type { BrowserAdapter } from "@/browser";
import type { AgentEventBus } from "@/shared/event-bus";
import type { ContentRequest, ContentErrorCode, ObservationSnapshot, ActionResult } from "@/shared/messages";
import type { AgentAction } from "@/shared/action-schema";
import type { PlanMeta, TaskData, TaskStep } from "@/shared/types";
import {
  BROWSER_LEVEL_ACTIONS,
  TERMINAL_ACTIONS,
  actionCapabilityLevel,
  isUnsupportedPageUrl,
} from "@/shared/pages";

import { StateManager } from "./state-manager";
import { TaskMemory } from "./memory";
import { interpretTask } from "./task-interpreter";
import { validateAction as validateAgainstSnapshot } from "./action-validator";
import { assessAction, resolveTargetContext } from "./risk-manager";
import { verifyAction } from "./verifier";
import { verifyTarget } from "./target-verifier";
import { evaluateActionSafety } from "./safety-policy";
import { RecoveryManager } from "./recovery-manager";
import { checkCompletion, PLACEMENT_ACTIONS } from "./completion-detector";
import { buildTaskIntent, type TaskIntent } from "./task-intent";
import { extractSemanticFacts } from "./visual-memory";
import type { VisualMemoryStore } from "./memory-store";
import {
  checkPreActionDrift,
  checkPostActionDrift,
  isCompletionWithinBoundary,
  actionOpOf,
  hostOf,
  type DriftAssessment,
} from "./drift";
import { assessTrust } from "./trust";
import type { RetrievalResult } from "./memory-store";
import { planNextAction } from "./deterministic-planner";
import type { ObservationEntry } from "./memory";
import type { ActionPlanner } from "./llm-planner";
import type { PlannerPlan } from "./types";

export type ControllerStatus = {
  runtime: import("./state-manager").AgentRuntimeStatus;
  ui: import("@/shared/types").AgentStateKey;
};

export class AgentController {
  private state = new StateManager();
  private memory = new TaskMemory();
  private recovery = new RecoveryManager();
  private paused = false;
  private pausedResolve: (() => void) | null = null;
  private pendingConfirmation: ((confirm: boolean) => void) | null = null;
  /** The tab id the controller is currently driving (updated every iteration). */
  private workingTabId = -1;
  /** Last known URL of the working tab (from the tab query, not the DOM). */
  private workingTabUrl = "";
  /**
   * Whether the working tab currently exposes page controls. A
   * browser-internal page (chrome://…) is NOT page-controllable, but the tab
   * itself may still accept browser-level actions (navigate/new_tab/…).
   */
  private pageControllable = true;

  /**
   * The task plan driving the Action Timeline. The controller is the single
   * writer: the planner seeds it (Groq plan, or the local task-sourced
   * fallback) and plan/action events mutate step statuses.
   */
  private planSteps: TaskStep[] = [];
  private planMeta: PlanMeta = { source: "local" };
  /**
   * Structured task data (user-provided inputs, model-generated sample data,
   * interpretation) seeded by the planner's first decision alongside the plan.
   */
  private taskData: TaskData | null = null;

  /**
   * Execution generation. Every `run()` (and every `stop()`) bumps this;
   * the loop carries its own id and exits silently when superseded, so a
   * stale async result (late planner response, parked confirmation, retry
   * timer) can never mutate a completed / stopped / replaced task.
   */
  private runId = 0;
  /** Current task id (per run) for canonical action binding. */
  private taskId = "";
  /** Monotonic action sequence (per run) for canonical action ids. */
  private actionSeq = 0;
  /**
   * Manual-verification state (Phase 17). Execution-complete and objective
   * verification are separate: the loop ends at TASK_COMPLETED with
   * "pending"; only an explicit submitVerification() call (the user
   * inspecting the real page) resolves it to passed/failed.
   */
  private verification: "none" | "pending" | "passed" | "failed" = "none";
  /**
   * Approval awaiting user decision. Bound to the exact action instance
   * ({actionId, url, target}) — approvals for anything else are ignored,
   * and each approval is consumed exactly once.
   */
  private pendingApproval: { actionId: string; url: string; targetKey: string } | null = null;
  /** Approvals already consumed (duplicate-approval protection). */
  private consumedApprovals = new Set<string>();
  /**
   * The user's ORIGINAL intent (Feature #4 anchor). Built once per run
   * from the goal string; never mutated by page content afterwards.
   */
  private intent: TaskIntent | null = null;
  /**
   * Hosts the agent itself arrived at (seed + own navigation chain).
   * Arrival anywhere else without agent navigation is redirect drift.
   */
  private allowedDomains = new Set<string>();
  /** Origin tab host seeded once per run (the user's starting context). */
  private originSeeded = false;
  /** The seeded origin host: user context, NOT task-owned evidence. */
  private originHost = "";
  /**
   * Feature #6 trust trend (task-scoped, in-memory only): prior
   * assessment scores, oldest→newest. Never persisted, never sent.
   */
  private trustScores: number[] = [];
  /** Last Feature #4 drift summary (supporting context for trust). */
  private lastDrift: { score: number; severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"; decision: string } | null = null;
  /** Last Feature #3 risk level (supporting context for trust). */
  private lastSafetyRisk: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" | null = null;
  /** Unprompted cross-host hops this run (redirect-chain depth). */
  private trustRedirects = 0;
  /** Signature of the last trust PAUSE (repeat-static downgrade). */
  private lastTrustPauseKey: string | null = null;
  /** Last compatible Feature #5 memories (bounded trust context). */
  private lastRecall: RetrievalResult[] = [];
  /**
   * Cross-session visual memory (Feature #5). Optional: null disables
   * recall/persist entirely and the loop behaves exactly as before.
   */
  private memoryHint: string[] = [];
  private memoryRecalled = false;

  /**
   * @param planner  Optional action planner — when provided the controller
   *                 delegates planning to it; falls back to the built-in
   *                 deterministic planner when omitted. Accepts the
   *                 `ActionPlanner` async signature from llm-planner.ts.
   * @param memoryStore Optional cross-session visual memory. Null (default)
   *                 disables Feature #5; the loop is otherwise identical.
   */
  constructor(
    private readonly adapter: BrowserAdapter,
    private readonly bus: AgentEventBus,
    private readonly planner: ActionPlanner = planNextAction,
    private readonly memoryStore: VisualMemoryStore | null = null,
  ) {}

  private alive(id: number): boolean {
    return id === this.runId;
  }

  /** Wake every parked waiter without satisfying it (stale loops exit via the generation check). */
  private invalidateWaiters(): void {
    this.pausedResolve?.();
    this.pausedResolve = null;
    this.pendingApproval = null;
    this.pendingConfirmation?.(false);
    this.pendingConfirmation = null;
  }

  /* ---- public control surface ---- */

  pause(): void {
    if (this.state.status === "IDLE" || this.state.status === "COMPLETED" || this.state.status === "FAILED") return;
    this.state.force("PAUSED");
    this.bus.emit("TASK_PAUSED", { reason: "Paused by user." });
    this.bus.emit("STATUS_CHANGED", { status: "PAUSED" });
    this.paused = true;
  }

  resume(): void {
    if (this.state.status !== "PAUSED") return;
    this.paused = false;
    this.bus.emit("TASK_RESUMED", {});
    this.pausedResolve?.();
    this.pausedResolve = null;
  }

  /** User confirmed a high-risk action. Bound to the pending approval's
   * actionId when given — stale or foreign approvals are ignored, and an
   * approval is consumed exactly once (duplicate approvals are no-ops). */
  confirm(actionId?: string): void {
    if (!this.pendingApproval) return;
    if (actionId && actionId !== this.pendingApproval.actionId) return;
    this.pendingApproval = null;
    this.pendingConfirmation?.(true);
    this.pendingConfirmation = null;
  }

  /** User denied a high-risk action. */
  deny(): void {
    this.pendingApproval = null;
    this.pendingConfirmation?.(false);
    this.pendingConfirmation = null;
  }

  /**
   * User-initiated stop. Orphans the current loop generation (no stale
   * async result may touch the task afterwards), wakes parked pause /
   * confirmation waiters, and returns the runtime to IDLE. Emits no
   * TASK_FAILED — a stop is not a failure.
   */
  stop(): void {
    this.runId++;
    this.paused = false;
    this.invalidateWaiters();
    this.state.reset();
    this.emitStatus();
  }

  get status(): ControllerStatus {
    return { runtime: this.state.status, ui: this.state.ui };
  }

  /* ---- the closed loop ---- */

  async run(goal: string, defaultTabId: number): Promise<void> {
    const runId = ++this.runId;
    this.state.reset();
    this.memory.reset();
    this.recovery.reset();
    this.paused = false;
    this.invalidateWaiters();
    this.planSteps = [];
    this.planMeta = { source: "local" };
    this.taskData = null;
    this.taskId = `task_${Date.now()}`;
    this.actionSeq = 0;
    this.verification = "none";
    this.consumedApprovals.clear();
    this.allowedDomains.clear();
    this.originSeeded = false;
    this.originHost = "";
    this.trustScores = [];
    this.trustRedirects = 0;
    this.lastTrustPauseKey = null;
    this.lastDrift = null;
    this.lastSafetyRisk = null;
    this.lastRecall = [];
    this.memoryHint = [];
    this.memoryRecalled = false;

    this.bus.emit("TASK_STARTED", { taskId: this.taskId, goal });
    this.emitStatus();

    const task = interpretTask(goal);
    // Feature #4 anchor: normalized ONCE from the user goal. Page content
    // can trigger drift findings against it, never rewrite it.
    this.intent = buildTaskIntent(this.taskId, task);
    const seedHost = hostOf(task.startUrl);
    if (seedHost) this.allowedDomains.add(seedHost);
    this.transition("UNDERSTANDING");

    // Resolve the initial working tab (bootstrap from the caller's id).
    this.workingTabId = defaultTabId;
    this.pageControllable = true;

    // Handshake: confirm the content bridge is alive before observing.
    // An unsupported page (chrome://…) is NOT fatal here: the tab itself may
    // still accept browser-level actions, so the loop gets a chance to
    // navigate away to a scriptable page instead of failing immediately.
    const alive = await this.handshake(this.workingTabId);
    if (!this.alive(runId)) return;
    if (!alive.ok && alive.code !== "unsupported_page") {
      // No live bridge: the task cannot execute, but this is recoverable
      // (reload the tab, then resume) — pause, never a global error. On
      // resume the loop below re-handshakes via observation; on stop the
      // generation is orphaned and we exit.
      await this.pauseTask(alive.message ?? alive.code ?? "Could not connect to the browser page.", runId);
      if (!this.alive(runId)) return;
    }

    this.transition("OBSERVING");

    let stepIndex = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        if (this.paused) await this.waitWhilePaused();
        // Superseded (stop() or a newer run()) → exit silently. No stale
        // async result may restart or mutate a terminal task.
        if (!this.alive(runId)) return;
      if (this.state.isTerminal()) break;

      // 0. RE-RESOLVE ACTIVE TAB (multi-tab: follow the user's current tab).
      const tabBefore = this.workingTabId;
      await this.syncWorkingTab(defaultTabId);
      // A user-driven tab switch re-anchors observation: the new tab is
      // context, not a redirect — drift still judges its content.
      const tabSwitched = this.workingTabId !== tabBefore;

      // 1. OBSERVE — capability-aware. A browser-internal page has no DOM
      // bridge, so instead of dying here we record a synthetic snapshot and
      // let the planner drive a browser-level action (navigate away).
      this.bus.emit("OBSERVATION_STARTED", {});
      let snapshot: ObservationSnapshot;
      let freshness: "live" | "stale";
      try {
        try {
          const observed = await this.observe(this.workingTabId);
          snapshot = observed.snapshot;
          freshness = observed.freshness;
        } catch (err) {
          if (isStaleContextError(err)) {
            // Observation arrived from the wrong tab — re-resolve and read once
            // more before believing anything about the page.
            await this.syncWorkingTab(defaultTabId);
            const observed = await this.observe(this.workingTabId);
            snapshot = observed.snapshot;
            freshness = observed.freshness;
          } else if (isBridgeColdError(err)) {
            // SPA reloads/replacements legitimately drop the content bridge
            // for a moment (verified live: a same-URL navigation parks the
            // next read). Poll briefly before treating one cold read as a
            // dead page — persistent coldness still surfaces honestly below.
            const recovered = await this.waitForContentReady(this.workingTabId, this.workingTabUrl, 10000).catch(
              () => null,
            );
            if (!recovered) throw err;
            snapshot = recovered;
            freshness = "live";
          } else {
            throw err;
          }
        }
        this.pageControllable = true;
      } catch (err) {
        if (!isUnsupportedPageError(err)) throw err;
        snapshot = this.unsupportedSnapshot();
        freshness = "stale";
        if (this.pageControllable) {
          this.pageControllable = false;
          this.bus.emit("PAGE_NOT_CONTROLLABLE", { url: snapshot.url, tabId: this.workingTabId });
        }
      }
      // Previous observation BEFORE pushing: the redirect/change anchor
      // for drift detection (a domain change with no agent navigation
      // between the two is an unprompted redirect).
      const prevObservation = this.memory.recentObservation();
      // The origin tab is user context: seed its host once so finishing
      // where the task started is never "off-task".
      if (!this.originSeeded) {
        const originHost = hostOf(snapshot.url);
        if (originHost) {
          this.allowedDomains.add(originHost);
          this.originHost = originHost;
          this.originSeeded = true;
        }
      }
      this.memory.push({ kind: "observation", snapshot, ts: Date.now() });
      this.bus.emit("OBSERVATION_UPDATED", { snapshot, freshness });
      if (!this.alive(runId)) return;
      // Feature #5 recall (once per run, after first contact): compatible
      // prior layout knowledge becomes planner context lines. Absent,
      // stale, incompatible or failed memory → fresh perception only.
      if (!this.memoryRecalled) {
        this.memoryRecalled = true;
        await this.recallVisualMemory(snapshot, runId);
      }
      if (!this.alive(runId)) return;
      if (this.paused) await this.waitWhilePaused();
      if (!this.alive(runId)) return;

      // 1b. ENVIRONMENT TRUST (Feature #6) — cheap, every observation,
      // BEFORE completion/planning. CRITICAL environments fail closed;
      // PAUSE replans bounded; VERIFY/WARN ride along as recorded
      // vigilance (this iteration's fresh observation IS the re-check).
      if (this.intent && snapshot.pageType !== "unsupported") {
        const trust = this.evaluateTrust(snapshot, prevObservation, tabSwitched);
        this.trustScores.push(trust.score);
        if (this.trustScores.length > 10) this.trustScores.shift();
        // Repeat-static downgrade: the same hostile page already paused
        // once — re-pausing would burn the recovery budget without new
        // information. Defer to the drift/safety gates per action, keep
        // watching (any new signal re-arms a fresh PAUSE).
        let effectiveDecision = trust.decision;
        const pauseKey = `${trust.level}:${trust.signals.map((s) => s.evidenceCode).sort().join(",")}`;
        const reasons = trust.signals
          .filter((s) => s.severity === "SUSPICIOUS" || s.severity === "CRITICAL")
          .map((s) => s.evidenceCode);
        if (trust.decision === "PAUSE") {
          if (pauseKey === this.lastTrustPauseKey) {
            effectiveDecision = "WARN";
            reasons.push("repeat static assessment — deferred to drift/safety");
          }
          this.lastTrustPauseKey = pauseKey;
        } else {
          this.lastTrustPauseKey = null;
        }
        this.bus.emit("TRUST_EVENT", {
          eventId: `trust_${Date.now()}`,
          taskId: this.taskId,
          score: trust.score,
          level: trust.level,
          decision: effectiveDecision,
          signals: trust.signals.map((s) => s.evidenceCode),
          reasons,
        });
        if (trust.decision === "BLOCK") {
          if (!this.alive(runId)) return;
          this.bus.emit("TASK_FAILED", {
            reason: `Blocked: untrusted environment (${trust.level} ${trust.score}/100: ${reasons.join(", ")})`,
          });
          this.transition("FAILED");
          this.emitStatus();
          break;
        }
        if (effectiveDecision === "PAUSE") {
          this.transition("RECOVERY");
          const rec = this.planRecovery(
            `environment trust ${trust.level} (${trust.score}/100): ${reasons.join(", ")}`,
          );
          if (rec.terminal) {
            await this.pauseTask(rec.terminalReason ?? "environment trust", runId);
            if (!this.alive(runId)) return;
            stepIndex = Math.max(0, stepIndex - 1);
            continue;
          }
          // No stepIndex change: the trust gate runs PRE-plan, so the
          // counter still points at the next unplanned step. Decrementing
          // here replays an already-verified step (verified live: a trust
          // pause after a successful search re-emitted "submit the search"
          // on the results page instead of advancing to video selection).
          continue;
        }
      }

      // 2. CHECK COMPLETION — guarded by the task boundary (Feature #4):
      // arriving at checkout/payment/an off-task domain during a
      // non-transactional task is DRIFT, not success.
      const completion = checkCompletion(task, snapshot, this.memory.all());
      if (completion.done && this.intent) {
        const boundary = isCompletionWithinBoundary(this.intent, snapshot, [...this.allowedDomains]);
        if (!boundary.ok) {
          this.emitDrift(
            {
              decision: "PAUSE",
              driftScore: 0.7,
              alignmentScore: 0.3,
              components: { goal: 0.2, state: 0.2, domain: 0.5, action: 0.5, context: 0.5 },
              severity: "HIGH",
              driftTypes: ["TASK_BOUNDARY_DRIFT"],
              evidence: [{ type: "COMPLETION_BOUNDARY", expected: `boundary ${this.intent.boundary}`, observed: boundary.reason }],
              reasons: [`completion claimed outside task boundary: ${boundary.reason}`],
              event: null,
            },
            "completion",
          );
          if (await this.driftFailed(`completion outside task boundary: ${boundary.reason}`, runId)) break;
          // No stepIndex change: the trust gate runs PRE-plan, so the
          // counter still points at the next unplanned step. Decrementing
          // here replays an already-verified step (verified live: a trust
          // pause after a successful search re-emitted "submit the search"
          // on the results page instead of advancing to video selection).
          continue;
        }
      }
      if (completion.done) {
        // Substance rule: real interaction (beyond mere placement), or a
        // planned terminal answer to verify. An empty finish after only
        // placement navigation completes nothing describable — park
        // (verified live: an empty mid-load observation produced
        // finish("") after a bare navigate).
        const acted = this.memory
          .all()
          .some((e) => e.kind === "executed" && !TERMINAL_ACTIONS.has(e.action.action));
        const actedReal = this.memory
          .all()
          .some(
            (e) =>
              e.kind === "executed" &&
              !TERMINAL_ACTIONS.has(e.action.action) &&
              !PLACEMENT_ACTIONS.has(e.action.action) &&
              !NON_EVIDENTIARY_ACTIONS.has(e.action.action),
          );
        const answer = this.terminalAnswer();
        if (!actedReal && !answer) {
          await this.pauseTask(
            acted
              ? "The planner finished without an answer to verify."
              : "The planner finished without performing any browser action.",
            runId,
            "empty finish without observable accomplishment",
          );
          if (!this.alive(runId)) return;
          // No stepIndex change: the trust gate runs PRE-plan, so the
          // counter still points at the next unplanned step. Decrementing
          // here replays an already-verified step (verified live: a trust
          // pause after a successful search re-emitted "submit the search"
          // on the results page instead of advancing to video selection).
          continue;
        }
        this.completeTask(answer ?? completion.reason, runId, true);
        break;
      }

      // 3. PLAN
      this.transition("PLANNING");
      const executedSummary = this.memory
        .all()
        .filter((e): e is import("./memory").ExecutedEntry => e.kind === "executed")
        .map((e) => `${e.action.action} ${e.action.target?.elementId ?? e.action.url ?? ""}: ${e.ok ? "ok" : "failed"}`);
      // Recalled layout knowledge rides along as context (sanitized
      // semantic lines only — never records, never values).
      const history = [...this.memoryHint, ...executedSummary];
      const lastVerified = [...this.memory.all()]
        .reverse()
        .find((e): e is import("./memory").VerifiedEntry => e.kind === "verified");
      const lastVerification = lastVerified
        ? { ok: lastVerified.ok, action: lastVerified.action.action, evidence: lastVerified.evidence }
        : null;

      const plannerAction = await Promise.resolve(
        this.planner(task, stepIndex, snapshot, {
          history,
          verification: lastVerification,
          // Preserve the provider failure category in the task record and
          // on the bus (drawer truth) instead of silently continuing on
          // the local planner. Execution is unaffected.
          onProviderError: (info) => {            const tag = info.code ? ` [${info.code}${info.retryable ? ", retryable" : ""}]` : "";
            this.memory.push({
              kind: "error",
              message: `reasoning provider ${info.provider} ${info.stage} (${info.stage === "unavailable" ? "gateway unreachable" : info.stage}${info.error ? `: ${info.error}` : ""})${tag}; continuing on local planner`,
              ts: Date.now(),
            });
            this.bus.emit("PROVIDER_FALLBACK", {
              provider: info.provider,
              stage: info.stage,
              error: info.error,
              ...(info.code ? { code: info.code, retryable: info.retryable } : {}),
            });
          },
          // Pre-network firewall verdicts (metadata only) enter the task
          // record so every transmission is visibly gated.
          onFirewallAllow: (info) => {
            this.bus.emit("FIREWALL_DECISION", {
              provider: info.provider,
              decision: "ALLOW",
              reason: info.reason,
              detectedTypes: info.detectedTypes,
              redactionCount: info.redactionCount,
            });
          },
          onFirewallBlock: (info) => {
            this.bus.emit("FIREWALL_DECISION", {
              provider: info.provider,
              decision: "BLOCK",
              reason: info.reason,
              detectedTypes: info.detectedTypes,
              redactionCount: 0,
            });
          },
        }),
      );
      // A planner response that arrives after stop()/supersede must not
      // seed plans or actions into a terminal task.
      if (!this.alive(runId)) return;
      if (!plannerAction) {
        // Exhausted plan: complete only when something actually executed
        // (pure navigation tasks legitimately end here); zero executions
        // means the plan evaporated without touching the browser.
        const acted = this.memory.all().some((e) => e.kind === "executed");
        if (!acted) {
          await this.pauseTask(
            "The task ended without performing any browser action.",
            runId,
            "planner exhausted with zero executed actions",
          );
          if (!this.alive(runId)) return;
          // No stepIndex change: the trust gate runs PRE-plan, so the
          // counter still points at the next unplanned step. Decrementing
          // here replays an already-verified step (verified live: a trust
          // pause after a successful search re-emitted "submit the search"
          // on the results page instead of advancing to video selection).
          continue;
        }
        this.completeTask("no_planned_actions_remaining", runId, false);
        break;
      }

      // PLAN → TIMELINE: seed / revise the task plan. The plan rides along
      // on the planner's decision; a revised plan replaces the remaining
      // (non-done) steps. The controller keeps provenance (groq vs local
      // fallback) and re-emits PLAN_CHANGED so the UI mirrors it verbatim.
      this.applyPlannerPlan(plannerAction.plan);

      // CAPABILITY POLICY — an unscriptable page accepts browser-level
      // actions only. When the planner proposes page work (or gives up via
      // finish) before this task has EVER seen a controllable page, and the
      // goal names a destination, the agent performs the initial
      // browser-level navigation itself instead of failing or burning
      // recovery retries. ask_user still escalates; with no destination the
      // honest failure below still applies.
      let effectiveAction = plannerAction.action;
      const needsPage = actionCapabilityLevel(effectiveAction.action) === "page";
      const gaveUp = effectiveAction.action === "finish";
      if (
        snapshot.pageType === "unsupported" &&
        (needsPage || gaveUp) &&
        task.startUrl &&
        !this.hasSeenControllablePage()
      ) {
        effectiveAction = {
          action: "navigate",
          url: task.startUrl,
          confidence: 0.8,
          expectedOutcome: this.navigateExpectation(task.startUrl),
        };
      }
      // A finish that survived the policy above means the plan needs the
      // CURRENT internal page (nothing to navigate to) — an honest
      // limitation. Fail with a clear message instead of a vacuous
      // empty finish.
      this.memory.push({ kind: "planned", action: effectiveAction, ts: Date.now() });
      this.bus.emit("PLAN_CREATED", { action: effectiveAction });
      stepIndex++;

      if (snapshot.pageType === "unsupported" && effectiveAction.action === "finish") {
        // The task needs this exact internal page, which exposes no DOM
        // controls. Honest and recoverable (navigate somewhere drivable,
        // then resume) — pause, never a global error.
        await this.pauseTask(
          `This browser page (${snapshot.url || "internal page"}) does not expose webpage controls, and the task needs this exact page. Open or navigate to a normal website first.`,
          runId,
        );
        if (!this.alive(runId)) return;
        stepIndex = Math.max(0, stepIndex - 1);
        continue;
      }

      // Ground the target identity ONCE against this snapshot so the
      // drift gate, validator, risk engine and executor all share WHAT
      // is being touched (planners only carry elementIds; the label
      // lives in the observation).
      const groundedAction = resolveTargetContext(effectiveAction, snapshot);

      // 3b. INTENT DRIFT GATE (Feature #4) — does this proposed action
      // still belong to the user's ORIGINAL task? Runs BEFORE the
      // Feature #3 safety gate: drifted actions never reach authorization.
      // The intent object is read-only here; page content cannot rewrite it.
      if (this.intent && snapshot.pageType !== "unsupported") {
        const preDrift = checkPreActionDrift({
          intent: this.intent,
          snapshot,
          action: groundedAction,
          ctx: {
            intent: this.intent,
            allowedDomains: [...this.allowedDomains],
            prevSnapshot: prevObservation,
            lastExecuted: this.lastExecutedAction(),
            tabSwitched,
          },
        });
        if (preDrift.decision === "ABORT") {
          this.emitDrift(preDrift, "pre");
          if (!this.alive(runId)) return;
          this.bus.emit("TASK_FAILED", {
            reason: `Stopped: ${preDrift.reasons.join("; ")}`,
          });
          this.transition("FAILED");
          this.emitStatus();
          break;
        }
        if (preDrift.decision === "VERIFY") {
          // One fresh observation; aligned-after-recheck proceeds.
          let fresh: ObservationSnapshot | null = null;
          try {
            fresh = (await this.observe(this.workingTabId)).snapshot;
          } catch {
            fresh = null;
          }
          if (!this.alive(runId)) return;
          const recheck = fresh
            ? checkPreActionDrift({
                intent: this.intent,
                snapshot: fresh,
                action: groundedAction,
                ctx: {
                  intent: this.intent,
                  allowedDomains: [...this.allowedDomains],
                  prevSnapshot: snapshot,
                  lastExecuted: this.lastExecutedAction(),
                  tabSwitched: false,
                },
              })
            : null;
          if (!recheck || recheck.decision !== "CONTINUE") {
            this.emitDrift(recheck ?? preDrift, "pre");
            if (await this.driftFailed(preDrift.reasons.join("; "), runId)) break;
            stepIndex = Math.max(0, stepIndex - 1);
            continue;
          }
          if (fresh) snapshot = fresh;
        } else if (preDrift.decision === "PAUSE" || preDrift.decision === "REPLAN") {
          this.emitDrift(preDrift, "pre");
          if (await this.driftFailed(preDrift.reasons.join("; "), runId)) break;
          // No stepIndex change: the trust gate runs PRE-plan, so the
          // counter still points at the next unplanned step. Decrementing
          // here replays an already-verified step (verified live: a trust
          // pause after a successful search re-emitted "submit the search"
          // on the results page instead of advancing to video selection).
          continue;
        }
      }

      // 4. VALIDATE
      this.transition("VALIDATING");
      this.bus.emit("ACTION_PROPOSED", { action: effectiveAction });
      const validation = validateAgainstSnapshot(effectiveAction, snapshot);
      if (!validation.ok) {
        this.bus.emit("ACTION_VALIDATED", { action: effectiveAction, ok: false, reasons: validation.reasons });
        this.transition("RECOVERY");
        const rec = this.planRecovery(validation.reasons.join("; "));
        if (rec.terminal) {
          await this.pauseTask(rec.terminalReason ?? "validation failed", runId);
          if (!this.alive(runId)) return;
          // No stepIndex change: the trust gate runs PRE-plan, so the
          // counter still points at the next unplanned step. Decrementing
          // here replays an already-verified step (verified live: a trust
          // pause after a successful search re-emitted "submit the search"
          // on the results page instead of advancing to video selection).
          continue;
        }
        stepIndex = Math.max(0, stepIndex - 1);
        continue;
      }
      this.bus.emit("ACTION_VALIDATED", { action: effectiveAction, ok: true, reasons: [] });

      // 5. SAFETY GATE — the single local authority on whether this
      // AI-proposed action may execute. The action was already grounded
      // above; verify the target against the CURRENT snapshot, evaluate
      // confidence × risk through the centralized policy, then branch.
      // The backend/planner proposes; only this gate authorizes.
      const risk = assessAction(groundedAction, snapshot);
      const actionId = `act_${runId}_${++this.actionSeq}`;
      const targetCheck = verifyTarget(groundedAction, snapshot, { tabUrl: this.workingTabUrl });
      const evaluation = evaluateActionSafety({
        canonical: {
          actionId,
          taskId: this.taskId,
          action: groundedAction,
          proposedConfidence: groundedAction.confidence,
          goal: task.goal,
          plannedUrl: snapshot.url,
        },
        risk: risk.level,
        riskRequiresConfirmation: risk.requiresConfirmation,
        target: targetCheck,
        validityOk: true,
        contextFresh: targetCheck.status !== "stale",
        verifiable: snapshot.pageType !== "unsupported",
      });
      this.bus.emit("SAFETY_DECIDED", {
        actionId,
        decision: evaluation.decision,
        confidence: evaluation.confidence.final,
        risk: evaluation.risk,
        target: evaluation.target.status,
        reasons: evaluation.reasons,
      });
      // Supporting context for Feature #6 (consumed next iteration).
      this.lastSafetyRisk = evaluation.risk;

      if (evaluation.decision === "BLOCK") {
        if (!this.alive(runId)) return;
        this.bus.emit("TASK_FAILED", { reason: `Blocked: ${evaluation.reasons.join("; ")}` });
        this.transition("FAILED");
        this.emitStatus();
        break;
      }

      if (evaluation.decision === "REPLAN") {
        this.transition("RECOVERY");
        const rec = this.planRecovery(evaluation.reasons.join("; "));
        if (rec.terminal) {
          await this.pauseTask(rec.terminalReason ?? "replan failed", runId);
          if (!this.alive(runId)) return;
          // No stepIndex change: the trust gate runs PRE-plan, so the
          // counter still points at the next unplanned step. Decrementing
          // here replays an already-verified step (verified live: a trust
          // pause after a successful search re-emitted "submit the search"
          // on the results page instead of advancing to video selection).
          continue;
        }
        stepIndex = Math.max(0, stepIndex - 1);
        continue;
      }

      if (evaluation.decision === "LOCAL_VERIFY") {
        // One fresh observation + target re-check before trusting it.
        let fresh: ObservationSnapshot;
        try {
          fresh = (await this.observe(this.workingTabId)).snapshot;
        } catch (err) {
          this.transition("RECOVERY");
          const rec = this.planRecovery(`re-observation failed during local verify: ${err instanceof Error ? err.message : String(err)}`);
          if (rec.terminal) {
            await this.pauseTask(rec.terminalReason ?? "replan failed", runId);
            if (!this.alive(runId)) return;
            stepIndex = Math.max(0, stepIndex - 1);
            continue;
          }
          // No stepIndex change: the trust gate runs PRE-plan, so the
          // counter still points at the next unplanned step. Decrementing
          // here replays an already-verified step (verified live: a trust
          // pause after a successful search re-emitted "submit the search"
          // on the results page instead of advancing to video selection).
          continue;
        }
        if (!this.alive(runId)) return;
        const recheck = verifyTarget(groundedAction, fresh, { tabUrl: this.workingTabUrl });
        if (recheck.status !== "verified") {
          this.transition("RECOVERY");
          const rec = this.planRecovery(`local verify failed: ${recheck.reason}`);
          if (rec.terminal) {
            await this.pauseTask(rec.terminalReason ?? "replan failed", runId);
            if (!this.alive(runId)) return;
            stepIndex = Math.max(0, stepIndex - 1);
            continue;
          }
          // No stepIndex change: the trust gate runs PRE-plan, so the
          // counter still points at the next unplanned step. Decrementing
          // here replays an already-verified step (verified live: a trust
          // pause after a successful search re-emitted "submit the search"
          // on the results page instead of advancing to video selection).
          continue;
        }
        snapshot = fresh;
      }

      if (evaluation.decision === "USER_CONFIRMATION_REQUIRED") {
        const approval = {
          actionId,
          url: snapshot.url,
          targetKey:
            groundedAction.target?.elementId ??
            `${groundedAction.target?.role ?? ""}|${groundedAction.target?.name ?? ""}`,
        };
        this.pendingApproval = approval;
        const confirmation = this.waitForConfirmation();
        this.transition("ASK_USER");
        this.bus.emit("USER_INPUT_REQUIRED", {
          reason: [...risk.reasons, ...evaluation.reasons].join("; "),
          confirmable: true,
          actionId,
          actionLabel: describeSafetyAction(groundedAction),
          riskLevel: risk.level,
          confidence: evaluation.confidence.final,
        });
        const confirmed = await confirmation;
        if (!this.alive(runId)) return;
        if (!confirmed || this.consumedApprovals.has(actionId)) {
          // User denied (or a duplicate approval arrived) → back to
          // observing with no recovery.
          this.transition("OBSERVING");
          continue;
        }
        this.consumedApprovals.add(actionId);
        // Approval is bound to the exact page + target: re-observe and
        // re-verify before executing anything approved.
        let fresh: ObservationSnapshot;
        try {
          fresh = (await this.observe(this.workingTabId)).snapshot;
        } catch {
          fresh = snapshot;
        }
        if (!this.alive(runId)) return;
        const recheck = verifyTarget(groundedAction, fresh, { tabUrl: this.workingTabUrl });
        if (fresh.url !== approval.url || recheck.status !== "verified") {
          this.bus.emit("APPROVAL_INVALIDATED", {
            actionId,
            reason:
              fresh.url !== approval.url
                ? `page changed since approval (${approval.url} → ${fresh.url})`
                : `target no longer verifiable (${recheck.reason})`,
          });
          this.transition("RECOVERY");
          const rec = this.planRecovery(`approval invalidated: page or target changed`);
          if (rec.terminal) {
            await this.pauseTask(rec.terminalReason ?? "replan failed", runId);
            if (!this.alive(runId)) return;
            stepIndex = Math.max(0, stepIndex - 1);
            continue;
          }
          // No stepIndex change: the trust gate runs PRE-plan, so the
          // counter still points at the next unplanned step. Decrementing
          // here replays an already-verified step (verified live: a trust
          // pause after a successful search re-emitted "submit the search"
          // on the results page instead of advancing to video selection).
          continue;
        }
        snapshot = fresh;
      }

      // 6. ACT — every lifecycle event below carries the traceability
      // envelope (taskId + canonical actionId + plan stepId) so logs
      // reconstruct Groq → engine → background → content → DOM per action.
      const trace = { taskId: this.taskId, actionId, stepId: this.currentStepId() };
      this.transition("ACTING");
      // No-progress guard: the same state-changing action succeeding over
      // and over with no other action between is a vacuous-verification
      // spin (the repeated-press_key defect) — park it instead of letting
      // recovery (which only counts failures) run forever. Read-only and
      // viewport actions (scroll/wait/hover/focus/extract/…) are exempt:
      // legitimately repeatable.
      if (!NO_PROGRESS_GUARD_EXEMPT.has(groundedAction.action)) {
        const signature = this.actionSignature(groundedAction);
        let repeats = 0;
        for (const entry of [...this.memory.all()].reverse()) {
          // Observations, plans and verifications interleave executions —
          // skip them. A failed execution or a different successful action
          // breaks the streak (failures consume the recovery budget).
          if (entry.kind !== "executed") continue;
          if (!entry.ok || this.actionSignature(entry.action) !== signature) break;
          repeats++;
        }
        if (repeats >= 3) {
          this.failPlanStep(`no progress: ${describeSafetyAction(groundedAction)} verified ${repeats + 1} times without advancing the task`);
          await this.pauseTask(
            `No progress: ${describeSafetyAction(groundedAction)} keeps succeeding without moving the task forward. The page may need a different interaction.`,
            runId,
          );
          if (!this.alive(runId)) return;
          // No stepIndex change: the trust gate runs PRE-plan, so the
          // counter still points at the next unplanned step. Decrementing
          // here replays an already-verified step (verified live: a trust
          // pause after a successful search re-emitted "submit the search"
          // on the results page instead of advancing to video selection).
          continue;
        }
      }
      this.bus.emit("ACTION_STARTED", { action: groundedAction, ...trace });
      this.activatePlanStep();
      const result = await this.executeAction(groundedAction, this.workingTabId);
      if (!this.alive(runId)) return;
      this.memory.push({ kind: "executed", action: groundedAction, ok: result.ok, details: result.details, ts: Date.now() });

      if (!result.ok) {
        this.bus.emit("ACTION_FAILED", { action: groundedAction, error: result.error ?? "action failed", details: result.details, ...trace });
        this.failPlanStep(result.error ?? "action failed");
        this.transition("RECOVERY");
        const rec = this.planRecovery(result.error ?? "unknown");
        if (rec.terminal) {
          await this.pauseTask(rec.terminalReason ?? "action failed", runId);
          if (!this.alive(runId)) return;
          // No stepIndex change: the trust gate runs PRE-plan, so the
          // counter still points at the next unplanned step. Decrementing
          // here replays an already-verified step (verified live: a trust
          // pause after a successful search re-emitted "submit the search"
          // on the results page instead of advancing to video selection).
          continue;
        }
        stepIndex = Math.max(0, stepIndex - 1);
        continue;
      }
      this.bus.emit("ACTION_SUCCEEDED", { action: groundedAction, hint: result.hint, ...trace });
      this.recovery.reset();

      // 7. VERIFY — after a tab-changing browser action the new page needs
      // time to load and re-announce its content bridge; wait for it instead
      // of failing on the first cold observation.
      this.transition("VERIFYING");
      this.bus.emit("VERIFICATION_STARTED", { action: groundedAction, ...trace });
      const freshSnapshot = await this.observeFresh(groundedAction, this.workingTabId, snapshot.url);
      const verification = await verifyAction(groundedAction, result.hint, snapshot, () => freshSnapshot);
      if (!this.alive(runId)) return;
      this.memory.push({ kind: "verified", action: groundedAction, ok: verification.ok, evidence: verification.evidence, ts: Date.now() });

      if (!verification.ok) {
        this.bus.emit("VERIFICATION_FAILED", { action: groundedAction, evidence: verification.evidence, ...trace });
        this.failPlanStep(verification.evidence.join("; "));
        this.transition("RECOVERY");
        const rec = this.planRecovery(verification.evidence.join("; "));
        if (rec.terminal) {
          await this.pauseTask(rec.terminalReason ?? "verification failed", runId);
          if (!this.alive(runId)) return;
          // No stepIndex change: the trust gate runs PRE-plan, so the
          // counter still points at the next unplanned step. Decrementing
          // here replays an already-verified step (verified live: a trust
          // pause after a successful search re-emitted "submit the search"
          // on the results page instead of advancing to video selection).
          continue;
        }
        stepIndex = Math.max(0, stepIndex - 1);
        continue;
      }
      this.bus.emit("VERIFICATION_SUCCEEDED", { action: groundedAction, evidence: verification.evidence, ...trace });
      this.completePlanStep();

      // 7b. POST-ACTION DRIFT CHECK (Feature #4) — did the world move
      // somewhere the task did not authorize? Agent-navigated hosts join
      // the allowed chain; everything else is judged against the intent.
      if (this.intent) {
        if (
          (groundedAction.action === "navigate" || groundedAction.action === "new_tab") &&
          groundedAction.url
        ) {
          const host = hostOf(groundedAction.url);
          if (host) this.allowedDomains.add(host);
        }
        const postDrift = checkPostActionDrift({
          intent: this.intent,
          prevSnapshot: snapshot,
          freshSnapshot,
          lastAction: groundedAction,
          actionOk: true,
          ctx: {
            intent: this.intent,
            allowedDomains: [...this.allowedDomains],
            prevSnapshot: snapshot,
            lastExecuted: { action: groundedAction, ok: true },
            tabSwitched: false,
          },
        });
        if (postDrift.decision === "ABORT") {
          this.emitDrift(postDrift, "post");
          if (!this.alive(runId)) return;
          this.bus.emit("TASK_FAILED", {
            reason: `Stopped: ${postDrift.reasons.join("; ")}`,
          });
          this.transition("FAILED");
          this.emitStatus();
          break;
        }
        if (postDrift.decision === "PAUSE" || postDrift.decision === "REPLAN") {
          this.emitDrift(postDrift, "post");
          if (await this.driftFailed(postDrift.reasons.join("; "), runId)) break;
          // No stepIndex change: the trust gate runs PRE-plan, so the
          // counter still points at the next unplanned step. Decrementing
          // here replays an already-verified step (verified live: a trust
          // pause after a successful search re-emitted "submit the search"
          // on the results page instead of advancing to video selection).
          continue;
        }
        if (postDrift.decision === "VERIFY") {
          // Already holding a fresh observation; the next loop
          // re-observes anyway — record and continue.
          this.emitDrift(postDrift, "post");
        }
      }

      // Back to OBSERVING for the next iteration.
      this.transition("OBSERVING");
      } catch (err) {
        // The live bridge dropped or the tab became unsupported (chrome://
        // and friends) mid-task. Never leave a false OBSERVING/ACTIVE
        // standing after the page can no longer be driven — and never
        // surface it as a global error: the user can reload or navigate
        // and resume. A superseded loop must not touch the task at all.
        if (!this.alive(runId)) return;
        await this.pauseTask(this.mapPlatformError(err), runId);
        if (!this.alive(runId)) return;
        stepIndex = Math.max(0, stepIndex - 1);
        continue;
      }
    }
  }

  /** Map platform/bridge failures onto user-facing messages. */
  private mapPlatformError(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err);
    const hit = raw.match(/(unsupported_page|no_active_tab|content_script_not_ready|no_extension)/);
    return hit ? this.humanError(hit[1] as ContentErrorCode) : raw;
  }

  /**
   * Re-resolve the active tab from the browser adapter. When the user has
   * switched tabs between loop iterations the controller follows them onto
   * the new tab. Falls back to `defaultTabId` when the adapter cannot
   * answer (e.g. dev preview without an extension context).
   */
  private async syncWorkingTab(defaultTabId: number): Promise<void> {
    try {
      const active = await this.adapter.queryActiveTab();
      const next = active?.id ?? defaultTabId;
      if (active?.url) this.workingTabUrl = active.url;
      if (next !== this.workingTabId) {
        const previous = this.workingTabId;
        this.workingTabId = next;
        this.bus.emit("TAB_CHANGED", { tabId: next, previous });
      }
    } catch {
      // Adapter unavailable — keep the current working tab.
    }
  }

  /* ---- internal helpers ---- */

  private transition(next: import("./state-manager").AgentRuntimeStatus): void {
    this.state.transition(next);
    this.emitStatus();
  }

  private emitStatus(): void {
    this.bus.emit("STATUS_CHANGED", { status: this.state.status });
  }

  /* ---- task plan (Action Timeline) ---- */

  /**
   * Seed or revise the task plan from a planner decision. On re-plan the
   * done prefix is kept, the revised plan covers the remaining path, and
   * steps the plan no longer contains surface as `replaced` — never
   * silently dropped.
   */
  private applyPlannerPlan(plan: PlannerPlan | undefined): void {
    if (!plan || !plan.steps || plan.steps.length === 0) return;
    const isFirst = this.planSteps.length === 0;
    const incoming = plan.steps.map((s) => ({ ...s, status: "pending" as const, statusReason: undefined }));
    if (!isFirst) {
      const remaining = this.planSteps
        .filter((s) => s.status !== "done")
        .map((s) => `${s.id}|${s.text}`);
      const same =
        remaining.length === incoming.length &&
        remaining.every((t, i) => t === `${incoming[i].id}|${incoming[i].text}`);
      if (same) return; // unchanged plan — keep the current timeline
    }
    const donePrefix = isFirst ? [] : this.planSteps.filter((s) => s.status === "done");
    const replaced = isFirst
      ? []
      : this.planSteps
          .filter((s) => s.status !== "done")
          .map((s) => ({ ...s, status: "replaced" as const, statusReason: "replaced by the revised plan" }));
    this.planSteps = [...donePrefix, ...incoming, ...replaced];
    this.planMeta = { source: plan.source, fallbackReason: plan.fallbackReason };
    // Structured task data rides with the plan; a refreshed data object
    // replaces the previous one, otherwise the existing snapshot is kept.
    if (plan.data) this.taskData = plan.data;
    this.activatePlanStep();
    this.bus.emit("PLAN_CHANGED", { steps: this.planSteps, meta: this.planMeta, data: this.taskData });
  }

  /** Activate the current working plan step (pending, active or failed-recovery). */
  private activatePlanStep(): void {
    const idx = this.planSteps.findIndex(
      (s) => s.status === "active" || s.status === "pending" || s.status === "failed",
    );
    if (idx < 0) return;
    if (this.planSteps[idx].status !== "active") {
      this.planSteps[idx] = { ...this.planSteps[idx], status: "active", statusReason: undefined };
      this.bus.emit("PLAN_CHANGED", { steps: this.planSteps, meta: this.planMeta, data: this.taskData });
    }
  }

  /** Mark the active step done (only called after verification succeeded) and advance. */
  private completePlanStep(): void {
    let idx = this.planSteps.findIndex((s) => s.status === "active");
    if (idx < 0) idx = this.planSteps.findIndex((s) => s.status === "pending");
    if (idx < 0) return;
    this.planSteps[idx] = { ...this.planSteps[idx], status: "done", statusReason: undefined };
    const next = this.planSteps.findIndex((s) => s.status === "pending");
    if (next >= 0) this.planSteps[next] = { ...this.planSteps[next], status: "active" };
    this.bus.emit("PLAN_CHANGED", { steps: this.planSteps, meta: this.planMeta, data: this.taskData });
  }

  /** Mark the active step failed with the reason (recovery may reactivate it). */
  private failPlanStep(reason: string): void {
    const idx = this.planSteps.findIndex((s) => s.status === "active");
    if (idx < 0) return;
    this.planSteps[idx] = { ...this.planSteps[idx], status: "failed", statusReason: reason.slice(0, 160) };
    this.bus.emit("PLAN_CHANGED", { steps: this.planSteps, meta: this.planMeta, data: this.taskData });
  }

  private async observe(tabId: number): Promise<{ snapshot: ObservationSnapshot; freshness: "live" | "stale" }> {
    const reply = await this.requestContent(tabId, { type: "CTX_OBSERVE" } as ContentRequest);
    // Transport-level failure (dead worker, no relay): never mistake the
    // absence of an answer for page state — surface it as no_extension so
    // the loop maps it to the honest "extension not detected" message.
    if ((reply as { __error?: unknown })?.__error != null) {
      throw new Error("observe: no_extension");
    }
    const payload = (reply as { payload?: ObservationSnapshot & { error?: ContentErrorCode } })?.payload;
    if (!payload) throw new Error("observe: no payload from content script");
    if ((payload as { error?: ContentErrorCode }).error) {
      const code = (payload as { error: ContentErrorCode }).error;
      throw new Error(`observe: ${code}`);
    }
    // The background relay stamps the origin tab; refuse observations that do
    // not belong to the working tab (unknown/negative ids pass — the content
    // script cannot know its own id on older builds).
    if (payload.tabId != null && payload.tabId >= 0 && payload.tabId !== tabId) {
      throw new Error(`observe: stale_context (snapshot from tab ${payload.tabId}, working tab ${tabId})`);
    }
    return { snapshot: payload, freshness: "live" };
  }

  /**
   * True once this task has observed a scriptable page. Guards the initial-
   * navigation policy: only before the first controllable observation may a
   * page-level plan be steered to the goal's start URL.
   */
  private hasSeenControllablePage(): boolean {
    return this.memory.all().some(
      (e): e is ObservationEntry =>
        e.kind === "observation" && (e.snapshot.pageType ?? "") !== "unsupported",
    );
  }

  /**
   * Expected outcome for a policy-steered initial navigation: a URL change,
   * pinned to the destination hostname when it parses, so verification runs
   * against the NEW browser state, never the pre-navigation page.
   */
  private navigateExpectation(startUrl: string): AgentAction["expectedOutcome"] {
    try {
      const host = new URL(startUrl).hostname;
      if (host) return { type: "url_change", urlContains: host };
    } catch {
      /* non-parseable destination — fall back to a bare URL change */
    }
    return { type: "url_change" };
  }

  /**
   * Synthetic snapshot for a browser-internal page: no DOM bridge exists, but
   * the tab is real and may accept browser-level actions. Element ids are
   * absent by construction, so page-level actions fail validation honestly.
   */
  private unsupportedSnapshot(): ObservationSnapshot {
    return {
      url: this.workingTabUrl,
      title: "",
      tabId: this.workingTabId,
      pageType: "unsupported",
      viewport: { w: 0, h: 0 },
      scrollY: 0,
      scrollH: 0,
      loading: false,
      visibleText: "",
      elements: [],
      counted: 0,
      createdAt: Date.now(),
    };
  }

  /**
   * Fresh observation for verification. After a tab-changing browser action
   * (navigate / reload / new_tab / switch_tab) the destination page needs
   * time to load and re-announce CONTENT_READY — poll until the bridge is
   * live instead of failing on the first cold read.
   */
  private async observeFresh(action: AgentAction, tabId: number, preUrl: string): Promise<ObservationSnapshot> {
    if (action.action === "navigate" || action.action === "reload" ||
        action.action === "new_tab" || action.action === "switch_tab") {
      return this.waitForContentReady(tabId, preUrl);
    }
    return (await this.observe(tabId)).snapshot;
  }

  /**
   * Bounded post-navigation wait. An "unsupported" reading immediately after
   * WE navigated from a known-internal page usually means the tab still
   * reports the pre-navigation URL (the new page has not committed yet) —
   * not a genuinely internal destination. So: losing a previously LIVE
   * page, or navigating from an unknown URL, fails fast (previous
   * behavior); starting from a KNOWN internal URL tolerates the commit
   * race within the bound, and only a confirmed still-internal URL fails
   * fast. Anything else polls to the bound, then fails honestly.
   */
  private async waitForContentReady(tabId: number, preUrl: string, timeoutMs = 15000): Promise<ObservationSnapshot> {
    const start = Date.now();
    let lastError: unknown = new Error("observe: content_script_not_ready");
    const commitRacePossible = !!preUrl && isUnsupportedPageUrl(preUrl);
    while (Date.now() - start < timeoutMs) {
      try {
        return (await this.observe(tabId)).snapshot;
      } catch (err) {
        lastError = err;
        if (isUnsupportedPageError(err)) {
          if (!commitRacePossible) throw err;
          const currentUrl = await this.safeTabUrl(tabId);
          if (currentUrl && currentUrl !== preUrl && isUnsupportedPageUrl(currentUrl)) throw err;
        }
        await delay(500);
      }
    }
    throw lastError;
  }

  /** Best-effort tab URL for race disambiguation; "" when unknowable. */
  private async safeTabUrl(tabId: number): Promise<string> {
    try {
      const current = await this.adapter.getTab(tabId);
      return current?.url ?? "";
    } catch {
      return "";
    }
  }

  /**
   * Connectivity handshake. Sends CTX_PING through the relay. The
   * background ContentChannel validates the URL and injects the content
   * script if needed before forwarding, so by the time we see a CTX_PONG
   * we know the bridge is live. On failure we map the error code to a
   * user-friendly message.
   */
  private async handshake(tabId: number): Promise<{ ok: boolean; code?: ContentErrorCode; message?: string }> {
    try {
      const reply = (await this.requestContent(tabId, { type: "CTX_PING" } as ContentRequest)) as
        | { type?: string; error?: ContentErrorCode; payload?: { error?: ContentErrorCode }; __error?: unknown }
        | undefined;
      // A transport failure (no relay answered at all) is not a live bridge.
      if (reply?.__error != null) {
        return { ok: false, code: "no_extension", message: this.humanError("no_extension") };
      }
      // Background already returns { error: code } when the ensure or relay fails.
      const code = reply?.error ?? reply?.payload?.error;
      if (code) {
        const message = this.humanError(code);
        return { ok: false, code, message };
      }
      // CTX_PONG came back — bridge is alive.
      return { ok: true };
    } catch {
      return { ok: false, code: "content_script_not_ready", message: this.humanError("content_script_not_ready") };
    }
  }

  private humanError(code: ContentErrorCode): string {
    switch (code) {
      case "unsupported_page":
        return "Browser page cannot be controlled. Open a regular webpage to continue.";
      case "content_script_not_ready":
        return "Could not connect to the browser page. Try reloading the tab.";
      case "no_active_tab":
        return "No browser tab is active. Open a tab and try again.";
      case "no_extension":
        return "Browser extension not detected.";
      default:
        return "Could not connect to the browser page.";
    }
  }

  private async executeAction(action: AgentAction, tabId: number): Promise<ActionResult> {
    // Terminal actions need no page/browser work — the completion
    // detector resolves the task from them.
    if (TERMINAL_ACTIONS.has(action.action)) {
      return { ok: true, details: action.result };
    }

    // Browser-level actions are split by where the work actually happens:
    // navigate / reload / new_tab / close_tab / switch_tab → background adapter.
    // back / forward → navigation manager via the adapter's delivery-checked
    // history primitives (never fire-and-forget when the agent needs a result).
    if (BROWSER_LEVEL_ACTIONS.has(action.action)) {
      switch (action.action) {
        case "navigate": {
          if (!action.url) return { ok: false, error: "missing_url" };
          try {
            await this.adapter.navigateTab(tabId, action.url);
            return { ok: true };
          } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : String(e) };
          }
        }
        case "reload": {
          try {
            await this.adapter.reloadTab(tabId);
            return { ok: true };
          } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : String(e) };
          }
        }
        case "new_tab": {
          try {
            const tab = await this.adapter.createTab(action.url);
            return tab ? { ok: true } : { ok: false, error: "failed to create tab" };
          } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : String(e) };
          }
        }
        case "close_tab": {
          try {
            await this.adapter.closeTab(tabId);
            return { ok: true };
          } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : String(e) };
          }
        }
        case "switch_tab": {
          try {
            if (action.url) {
              const tabs = await this.adapter.listTabs();
              const target = tabs.find((t) => t.url === action.url);
              if (target) await this.adapter.activateTab(target.id);
            }
            return { ok: true };
          } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : String(e) };
          }
        }
        case "back": {
          try {
            const delivered = await this.adapter.goBackTab(tabId);
            return delivered ? { ok: true } : { ok: false, error: "back failed" };
          } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : String(e) };
          }
        }
        case "forward": {
          try {
            const delivered = await this.adapter.goForwardTab(tabId);
            return delivered ? { ok: true } : { ok: false, error: "forward failed" };
          } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : String(e) };
          }
        }
        default:
          return { ok: false, error: `unknown_browser_action: ${action.action}` };
      }
    }

    const reply = await this.requestContent(tabId, {
      type: "CTX_EXECUTE",
      payload: { action },
    } as ContentRequest);
    return (reply as { payload?: ActionResult })?.payload ?? { ok: false, error: "no_response" };
  }

  private async requestContent(tabId: number, message: ContentRequest): Promise<unknown> {
    return this.adapter.sendToTabAndRespond(tabId, message);
  }

  private waitWhilePaused(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!this.paused) {
        resolve();
        return;
      }
      this.pausedResolve = resolve;
    });
  }

  private waitForConfirmation(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.pendingConfirmation = resolve;
    });
  }

  /**
   * Terminal completion funnel (single source: both completion sites).
   * TASK_COMPLETED means EXECUTION-complete: every planned browser action
   * ran with successful results. It never claims the OBJECTIVE was met —
   * that verdict belongs to submitVerification() (manual, Phase 17).
   * A finish with zero executed actions and no answer is a planner
   * give-up, not a completion: it parks instead of declaring success.
   * Persists visual memory as a fire-and-forget checkpoint — storage
   * can never fail or stall the finished task.
   */
  private completeTask(result: string, runId: number, completed: boolean): void {
    if (!this.alive(runId)) return;
    this.verification = "pending";
    this.bus.emit("TASK_COMPLETED", { result });
    this.transition("COMPLETED");
    this.emitStatus();
    this.persistVisualMemory(completed);
  }

  /**
   * Latest terminal answer the planner produced (finish result / ask_user
   * reason), or null when the plan carries no answer at all. An EMPTY
   * terminal answer is always a defect signal — no legitimate flow emits
   * one (backend requires result text; local fallbacks slice live page
   * text) — so it can never complete a task, no matter what ran before.
   */
  private terminalAnswer(): string | null {
    const terminal = [...this.memory.all()]
      .reverse()
      .find((e) => e.kind === "planned" && (e.action.action === "finish" || e.action.action === "ask_user"));
    if (!terminal || terminal.kind !== "planned") return null;
    const answer =
      terminal.action.action === "finish" ? terminal.action.result : terminal.action.reason;
    return answer?.trim() ? answer : null;
  }

  /**
   * Manual objective verification (Phase 17). Callable only after the run
   * reached execution-complete and before any stop/reset: records whether
   * the human-confirmed objective was met. Late, duplicate, or
   * out-of-lifecycle calls are ignored — verification can neither revive
   * a task nor rewrite its execution record.
   */
  submitVerification(ok: boolean, note?: string): void {
    if (this.state.status !== "COMPLETED" || this.verification !== "pending") return;
    this.verification = ok ? "passed" : "failed";
    this.bus.emit("TASK_VERIFIED", { taskId: this.taskId, ok, note });
  }

  /** Plan-step id driving the current action (traceability envelope). */
  private currentStepId(): string | undefined {
    return (
      this.planSteps.find((s) => s.status === "active")?.id ??
      this.planSteps.find((s) => s.status === "pending")?.id
    );
  }

  /** Feature #5 recall: compatible prior layout → planner hint lines. */
  private async recallVisualMemory(snapshot: ObservationSnapshot, runId: number): Promise<void> {
    const store = this.memoryStore;
    const intent = this.intent;
    if (!store || !intent || !this.alive(runId)) return;
    if (snapshot.pageType === "unsupported") return;
    try {
      const domain = hostOf(snapshot.url);
      if (!domain) return;
      const results = await store.recall(
        { domain, pageType: snapshot.pageType, taskType: intent.operation, limit: 3 },
        intent.goal,
        extractSemanticFacts(snapshot),
        domain,
      );
      if (!this.alive(runId)) return;
      this.memoryHint = store.contextLines(results);
      this.lastRecall = results;
    } catch {
      this.memoryHint = [];
      this.lastRecall = [];
    }
  }

  /** Feature #5 write checkpoint (task completion only — never per-event). */
  private persistVisualMemory(completed: boolean): void {
    const store = this.memoryStore;
    const intent = this.intent;
    if (!store || !intent) return;
    try {
      const snapshots = this.memory
        .all()
        .filter((e): e is import("./memory").ObservationEntry => e.kind === "observation")
        .map((e) => e.snapshot);
      const actions = this.memory.actions();
      void store
        .writeFromTask({ snapshots, actions, intent, completed })
        .catch(() => undefined);
    } catch {
      /* memory must never break the loop */
    }
  }

  /**
   * Assemble the local trust context and assess the environment
   * (Feature #6). All inputs are local + value-free; the score never
   * leaves the device except as level/decision metadata on TRUST_EVENT.
   */
  private evaluateTrust(
    snapshot: ObservationSnapshot,
    prevObservation: ObservationSnapshot | null,
    tabSwitched: boolean,
  ) {
    const intent = this.intent;
    const url = snapshot.url;
    const host = hostOf(url);
    const prevHost = prevObservation ? hostOf(prevObservation.url) : "";
    const lastExecuted = this.lastExecutedAction();
    const navigatedByAgent =
      !!lastExecuted && lastExecuted.ok && ["navigate", "new_tab", "switch_tab"].includes(lastExecuted.action.action);
    const redirectHop = !!prevHost && !!host && prevHost !== host && !navigatedByAgent && !tabSwitched;
    if (redirectHop) this.trustRedirects++;
    // Brand tokens feed lookalike-domain and brand-mismatch checks: only
    // site/platform entities are brand identity. Query words are search
    // terms, never brands — including them fired BRAND_DOMAIN_MISMATCH on
    // every results page whose title echoes the query (verified live:
    // "beginner"/"tutorial" vs youtube.com).
    const brandTokens: string[] = [];
    if (intent) {
      for (const e of intent.entities) {
        if (e.label === "site" || e.label === "platform") {
          for (const t of e.value.toLowerCase().split(/\W+/)) {
            if (t.length >= 4 && brandTokens.length < 8 && !brandTokens.includes(t)) brandTokens.push(t);
          }
        }
      }
    }
    const recentOps = this.memory
      .actions()
      .slice(-6)
      .map((a) => actionOpOf(a));
    const compatible = this.lastRecall.filter((r) => r.compatible);
    return assessTrust({
      taskId: this.taskId,
      url,
      prevUrl: prevObservation?.url ?? null,
      // Task-owned hosts: seed + agent navigation chain. The origin tab
      // is user context and stays excluded — UNLESS it is also an explicit
      // task destination (seed) or agent-navigated: then it is task-owned
      // by selection/arrival. Filtering unconditionally blinded every
      // assessment when a task starts on its destination host (verified
      // live: youtube.com seed == youtube.com origin → permanent
      // UNKNOWN_DOMAIN on every page of the run).
      expectedHosts: (() => {
        const seed = new Set((intent?.seedHosts ?? []).map((h) => h.toLowerCase()));
        return [...this.allowedDomains].filter(
          (h) => h.toLowerCase() !== this.originHost.toLowerCase() || seed.has(h.toLowerCase()),
        );
      })(),
      navigatedByAgent,
      redirectHop,
      redirectCount: this.trustRedirects,
      snapshot,
      driftScore: this.lastDrift?.score ?? null,
      driftSeverity: this.lastDrift?.severity ?? null,
      safetyRisk: this.lastSafetyRisk,
      memoryKnownStructure: compatible.length > 0,
      memoryConfidence: compatible.length > 0 ? Math.max(...compatible.map((r) => r.confidenceScore)) : 0,
      // Origin tab is user context: reported for override calibration,
      // never treated as task-owned evidence (see expectedHosts filter).
      isOrigin: host !== "" && host === this.originHost,
      brandTokens,
      transactional: intent?.transactional ?? false,
      recentOps,
      recentScores: [...this.trustScores],
    });
  }

  /**
   * Record + broadcast a drift assessment (Feature #4 drawer truth).
   * Value-free by construction: ids, scores, types, generic reasons.
   */
  private emitDrift(assessment: DriftAssessment, phase: "pre" | "post" | "completion"): void {
    const e = assessment.event;
    // Supporting context for Feature #6 (consumed next iteration).
    this.lastDrift = { score: assessment.driftScore, severity: assessment.severity, decision: assessment.decision };
    this.memory.push({
      kind: "error",
      message: `intent drift [${phase}] ${assessment.severity} (${assessment.driftTypes.join(",") || "none"}): ${assessment.reasons.join("; ")} → ${assessment.decision}`,
      ts: Date.now(),
    });
    this.bus.emit("DRIFT_EVENT", {
      eventId: e?.eventId ?? `drift_${Date.now()}`,
      taskId: this.taskId,
      phase,
      decision: assessment.decision,
      severity: assessment.severity,
      driftScore: assessment.driftScore,
      driftTypes: assessment.driftTypes,
      reasons: assessment.reasons,
    });
  }

  /**
   * Bounded drift recovery: replan within the ORIGINAL intent (which is
   * never mutated). Shares the recovery budget, so repeated drift
   * terminates honestly instead of looping forever. Returns true when
   * the loop must break.
   */
  private async driftFailed(reason: string, runId: number): Promise<boolean> {
    this.transition("RECOVERY");
    const rec = this.planRecovery(`intent drift: ${reason}`);
    if (!rec.terminal) return false;
    if (!this.alive(runId)) return true;
    // Recoverable drift (PAUSE/REPLAN exhausted, boundary drift) parks
    // the task — ABORT (injection) still fails via its own TASK_FAILED
    // path above and never reaches here.
    await this.pauseTask(rec.terminalReason ?? reason, runId);
    return true;
  }

  /** Last successfully executed action (drift navigation context). */
  private lastExecutedAction(): { action: AgentAction; ok: boolean } | null {
    const entries = this.memory.all();
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.kind === "executed") return { action: e.action, ok: e.ok };
    }
    return null;
  }

  /**
   * Shared recovery branch (single source: validation / safety / action /
   * verification failures all funnel here). Returns terminal + reason when
   * retries are exhausted; otherwise the caller steps back and continues.
   */
  private planRecovery(reason: string): { terminal: boolean; terminalReason?: string } {
    const recoveryAction = this.recovery.plan(reason);
    // Retry observability: the action under recovery rides along (value-free
    // label only) so each attempt carries attempt + reason + action +
    // retry decision.
    const lastPlanned = [...this.memory.all()].reverse().find((e) => e.kind === "planned");
    this.bus.emit("RECOVERY_ATTEMPT", {
      attempt: this.recovery.attempt,
      reason,
      strategy: recoveryAction.kind,
      action: lastPlanned && lastPlanned.kind === "planned" ? describeSafetyAction(lastPlanned.action) : undefined,
    });
    if (recoveryAction.kind === "give_up") {
      return { terminal: true, terminalReason: recoveryAction.reason };
    }
    return { terminal: false };
  }

  /**
   * Terminal task pause (single source for ALL recoverable exhaustion:
   * validation / action / verification / drift / trust-pause / platform
   * failures). Parks the loop with no timers and no background work —
   * nothing executes again until the user resumes (the loop re-observes
   * and retries the failed step) or stops (the generation is orphaned).
   *
   * Emits TASK_PAUSED, never TASK_FAILED: an ordinary execution failure
   * is task state (PAUSED + reason in the task UI), not a global
   * application error. TASK_FAILED is reserved for policy refusals
   * (safety BLOCK), hostile findings (drift ABORT, trust BLOCK).
   */
  private async pauseTask(reason: string, runId: number, technical?: string): Promise<void> {
    const step = this.planSteps.find((s) => s.status === "active" || s.status === "failed");
    this.transition("PAUSED");
    this.bus.emit("TASK_PAUSED", { reason, step: step?.text, technical });
    this.emitStatus();
    this.paused = true;
    await this.waitWhilePaused();
    this.paused = false;
    if (!this.alive(runId)) return;
    this.transition("OBSERVING");
  }

  /**
   * Value-free signature of an executed action for the no-progress guard
   * (action + target identity + key only — never typed text or URLs).
   */
  private actionSignature(action: AgentAction): string {
    return [
      action.action,
      action.target?.elementId ?? "",
      action.target?.role ?? "",
      action.target?.name ?? "",
      action.key ?? "",
    ].join("|");
  }
}

export { buildGuardedTimeline } from "./simulator";
export type { GuardedStep, GuardedTimeline, HoldInfo } from "./simulator";

/** True when an observe/handshake failure means "browser-internal page". */
function isUnsupportedPageError(err: unknown): boolean {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.includes("unsupported_page");
}

/** True when an observation arrived from a tab we are not driving. */
function isStaleContextError(err: unknown): boolean {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.includes("stale_context");
}

/** True when the content bridge exists but is momentarily cold (reloading
 *  page, fresh navigation, worker restart) — worth one bounded re-poll,
 *  unlike a wrong-tab or unsupported-page reading. */
function isBridgeColdError(err: unknown): boolean {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.includes("content_script_not_ready") || raw.includes("no_extension");
}

/**
 * Value-free action label for confirmation surfaces and logs: action
 * name + target label only. Typed text, URLs and option values are
 * deliberately excluded (they may carry PII or secrets).
 */
function describeSafetyAction(action: AgentAction): string {
  const name = action?.action ?? "step";
  const label = action?.target?.name;
  return label ? `${name} → ${label}` : name;
}

const delay = (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Viewport-only actions: observable motion, never page accomplishment.
 * Excluded from completion substance (a run of pure waits/scrolls plus
 * an empty finish completes nothing describable).
 */
const NON_EVIDENTIARY_ACTIONS: ReadonlySet<string> = new Set(["wait", "scroll", "hover", "focus"]);

/**
 * Actions exempt from the no-progress guard: read-only, viewport, or
 * navigation primitives that legitimately repeat (infinite scroll,
 * polling waits, re-observation hovers, page reloads, …).
 */
const NO_PROGRESS_GUARD_EXEMPT: ReadonlySet<string> = new Set([
  "scroll",
  "wait",
  "hover",
  "focus",
  "extract",
  "navigate",
  "reload",
  "back",
  "forward",
  "switch_tab",
  "finish",
  "ask_user",
]);