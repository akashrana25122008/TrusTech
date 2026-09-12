/* ------------------------------------------------------------------ *
 * Intent drift detection — LOCAL alignment of live browser activity
 * against the user's ORIGINAL TaskIntent.
 *
 * Authority order (never inverted): Safety Policy > User Intent >
 * Local Task State > AI Plan > Web Page Content. Page instructions
 * are UNTRUSTED input: they can trigger drift findings, never rewrite
 * the intent (buildTaskIntent takes no snapshot — by construction).
 *
 * Layered checks (cheap first): domain/URL → page semantics →
 * action/operation → dialogs/injection cues. Deterministic, pure,
 * value-free evidence. No network, no screenshots, no PII in events.
 * ------------------------------------------------------------------ */

import type { AgentAction } from "@/shared/action-schema";
import type { ObservationSnapshot } from "@/shared/messages";
import { intentTokens, type TaskIntent, type TaskOperation } from "./task-intent";

export type DriftType =
  | "NAVIGATION_DRIFT"
  | "TASK_DRIFT"
  | "UI_DRIFT"
  | "ACTION_DRIFT"
  | "SEMANTIC_DRIFT"
  | "REDIRECT_DRIFT"
  | "POPUP_DRIFT"
  | "TASK_BOUNDARY_DRIFT";

export type DriftSeverity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type DriftDecision = "CONTINUE" | "VERIFY" | "PAUSE" | "REPLAN" | "ABORT";

export interface DriftEvidence {
  type:
    | "DOMAIN_MISMATCH"
    | "UNEXPECTED_REDIRECT"
    | "TASK_BOUNDARY_VIOLATION"
    | "GOAL_ESCALATION"
    | "OPERATION_MISMATCH"
    | "PAGE_SEMANTICS_MISMATCH"
    | "DIALOG_STATE"
    | "INJECTION_CUE"
    | "USER_INTENT_CONFLICT"
    | "COMPLETION_BOUNDARY";
  expected?: string;
  observed?: string;
  detail?: string;
}

export interface IntentDriftEvent {
  eventId: string;
  taskId: string;
  previousState: string;
  currentState: string;
  driftScore: number;
  alignmentScore: number;
  driftTypes: DriftType[];
  evidence: DriftEvidence[];
  severity: DriftSeverity;
  decision: DriftDecision;
  timestamp: number;
}

export interface DriftComponents {
  goal: number;
  state: number;
  domain: number;
  action: number;
  context: number;
}

export interface DriftAssessment {
  decision: DriftDecision;
  driftScore: number;
  alignmentScore: number;
  components: DriftComponents;
  severity: DriftSeverity;
  driftTypes: DriftType[];
  evidence: DriftEvidence[];
  /** Value-free human reasons (safe for UI + logs). */
  reasons: string[];
  event: IntentDriftEvent | null;
}

/** Centralized weights — the ONLY drift formula. */
export const DRIFT_WEIGHTS = { goal: 0.3, state: 0.2, domain: 0.2, action: 0.2, context: 0.1 } as const;

/** Severity floors by drift score (type evidence can only escalate). */
const SCORE_SEVERITY: Array<{ at: number; severity: DriftSeverity }> = [
  { at: 0.8, severity: "CRITICAL" },
  { at: 0.55, severity: "HIGH" },
  { at: 0.35, severity: "MEDIUM" },
  { at: 0.12, severity: "LOW" },
];

let eventSeq = 0;

/* ---------------- URL / domain helpers ---------------- */

export function hostOf(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** Evidence-safe URL: host + pathname only (query/hash may carry PII). */
export function evidenceUrl(url: string | undefined): string {
  if (!url) return "(none)";
  try {
    const u = new URL(url);
    return `${u.hostname.toLowerCase()}${u.pathname || "/"}`;
  } catch {
    return "(unparseable)";
  }
}

/* ---------------- normalized browser state ---------------- */

export type DialogKind = "reward" | "auth" | "cookie" | "financial" | "generic" | null;

export interface NormalizedBrowserState {
  fingerprint: string;
  host: string;
  pageKind: "transaction" | "auth" | "search" | "content" | "internal";
  dialog: DialogKind;
  dialogCount: number;
  formCount: number;
  roles: string[];
  loading: boolean;
}

const REWARD_CUES = /congratulations|you (have )?won|claim (now|reward|prize)|free (prize|gift|money)|lottery|winner|₹\s?[\d,]+\s?(won|cash|prize)/i;
const AUTH_CUES = /sign in to continue|log ?in to continue|log ?in required|create an account|sign up to continue|login wall|session expired|verify (it('| i)s you|your identity)/i;
const COOKIE_CUES = /cookie|cookies|accept all|consent|privacy (notice|policy update)|we value your privacy|gdpr/i;
const FINANCIAL_CUES = /payment|checkout|place order|pay now|card details|billing|order summary|upi (id|payment)|net ?banking/i;
const TRANSACTION_CUES =
  /payment|checkout|place order|pay now|card details|billing|order summary|delete (my|your|the) account|permanently delete|set (a )?new password|create (an )?account.*(payment|billing|card)/i;
/** Reward/hijack lexicon — never task-relevant, even in transactional tasks. */
const HIJACK_TARGET = /claim|reward|prize|gift|free|winner|lottery|bonus/i;
const INJECTION_CUES =
  /ignore (all |any |the |previous |prior )?(previous |prior |earlier )?(instructions|instruction|request|prompt|system prompt)|disregard.*instructions|forget (everything|all|your) (instructions|task|directive)|you are now|new instructions:|system: ?(you|ignore)|prompt injection/i;
const CREDENTIAL_HARVEST_CUES =
  /upload your (credentials|identity|id|passport|document)|enter your bank details|share your (password|otp|pin)|verify your (bank|card|account) (details|now)/i;

function dialogKindFromText(text: string): DialogKind {
  if (REWARD_CUES.test(text) || CREDENTIAL_HARVEST_CUES.test(text)) return "reward";
  if (FINANCIAL_CUES.test(text)) return "financial";
  if (AUTH_CUES.test(text)) return "auth";
  if (COOKIE_CUES.test(text)) return "cookie";
  return null;
}

/**
 * Normalize a live snapshot into compact semantics. Reads labels/text
 * locally; the fingerprint keeps STRUCTURE only (no titles, no names,
 * no values) so it is safe to persist and log.
 */
export function normalizeBrowserState(snapshot: ObservationSnapshot): NormalizedBrowserState {
  const dialogRoles = new Set(["dialog", "alertdialog"]);
  const dialogEls = snapshot.elements.filter((e) => dialogRoles.has(e.role) && e.visible);
  const labelText = snapshot.elements
    .filter((e) => e.visible)
    .map((e) => e.name)
    .join(" \n ");
  const combined = `${labelText} \n ${snapshot.visibleText}`;
  let dialog: DialogKind = dialogEls.length > 0 ? "generic" : null;
  const cueKind = dialogKindFromText(combined);
  if (cueKind) dialog = cueKind;

  const roles = [...new Set(snapshot.elements.filter((e) => e.visible).map((e) => e.role))].sort();
  const formCount = snapshot.elements.filter(
    (e) => e.visible && (e.role === "textbox" || e.role === "searchbox" || e.tag === "input" || e.tag === "form"),
  ).length;

  const host = hostOf(snapshot.url);
  let pageKind: NormalizedBrowserState["pageKind"];
  if (snapshot.pageType === "unsupported" || !host) {
    pageKind = "internal";
  } else if (TRANSACTION_CUES.test(combined)) {
    pageKind = "transaction";
  } else if (AUTH_CUES.test(combined) && !snapshot.visibleText.toLowerCase().includes("search")) {
    pageKind = "auth";
  } else if (snapshot.elements.some((e) => e.visible && (e.role === "searchbox" || /search/i.test(e.name)))) {
    pageKind = "search";
  } else {
    pageKind = "content";
  }

  const fingerprint = [
    `host=${host || "internal"}`,
    `kind=${pageKind}`,
    `roles=${roles.join(",") || "none"}`,
    `dialog=${dialog ?? "none"}x${dialogEls.length}`,
    `forms=${formCount}`,
    `loading=${snapshot.loading ? 1 : 0}`,
  ].join("|");
  return { fingerprint, host, pageKind, dialog, dialogCount: dialogEls.length, formCount, roles, loading: snapshot.loading };
}

/* ---------------- action → operation mapping ---------------- */

const TRANSACTION_TARGET =
  /\b(buy|buys|pay|payment|checkout|place order|order now|book|booking|reserve|subscribe|claim|reward|prize|gift|donate|transfer|send money)\b/i;
const SUBMIT_TARGET = /\b(submit|send|confirm|apply|complete|finish|login|sign ?in|register)\b/i;
const FILTER_TARGET = /\b(filter|sort|price|size|color|brand|rating)\b/i;
const VIEW_TARGET = /\b(play|watch|open|view|read|show|details|more)\b/i;

/** Map a proposed action onto a task operation (local, lexical). */
export function actionOpOf(action: AgentAction): TaskOperation {
  switch (action.action) {
    case "navigate":
    case "new_tab":
    case "switch_tab":
    case "back":
    case "forward":
    case "reload":
      return "NAVIGATE";
    case "type":
      if ((action.target?.role === "searchbox") || /\bsearch\b/i.test(action.target?.name ?? "")) return "SEARCH";
      return "INPUT";
    case "select":
    case "check":
    case "uncheck":
    case "radio":
      return FILTER_TARGET.test(action.target?.name ?? "") ? "FILTER" : "INPUT";
    case "submit":
      return "SUBMIT";
    case "click":
    case "double_click": {
      const name = action.target?.name ?? "";
      if (TRANSACTION_TARGET.test(name)) return "TRANSACTION";
      if (SUBMIT_TARGET.test(name)) return "SUBMIT";
      if (FILTER_TARGET.test(name)) return "FILTER";
      if (VIEW_TARGET.test(name)) return "VIEW";
      return "VIEW";
    }
    case "extract":
      return "COLLECT";
    case "wait":
    case "press_key":
    case "scroll":
    case "hover":
    case "focus":
    case "clear":
    case "close_tab":
      return "OTHER";
    case "finish":
    case "ask_user":
      return "OTHER";
    default:
      return "OTHER";
  }
}

/* ---------------- intent helpers ---------------- */

function tokenOverlap(tokens: string[], haystack: string): number {
  if (tokens.length === 0) return 0;
  const lower = haystack.toLowerCase();
  return tokens.filter((t) => lower.includes(t)).length / tokens.length;
}

/** Relevance of a domain to the task (entity/site/query overlap). */
function domainRelevance(intent: TaskIntent, host: string): number {
  if (!host) return 0;
  const tokens = intentTokens(intent);
  const parts = host.toLowerCase().split(".");
  const hits = parts.filter((p) => p.length > 2 && tokens.some((t) => t.includes(p) || p.includes(t))).length;
  if (hits > 0) return 0.9;
  // Well-known search/media rails are relevant to lookup tasks.
  if (/google|bing|duckduckgo|youtube|wikipedia/i.test(host)) return 0.7;
  return 0.2;
}

function hasInjectionCues(snapshot: ObservationSnapshot): boolean {
  const text = `${snapshot.title} \n ${snapshot.visibleText}`;
  return INJECTION_CUES.test(text) || CREDENTIAL_HARVEST_CUES.test(text);
}

/**
 * Target asks for upload/credentials/identity/payment material — the
 * shape page-driven harvesting takes, whatever the mapped operation.
 */
function isCredentialHarvestTarget(action: AgentAction): boolean {
  if (action.action === "type" && /password|otp|card|cvv|cvc|pin\b|2fa|secret/i.test(action.target?.name ?? "")) {
    return true;
  }
  return /upload|attach|password|otp|bank|credential|identity|document|passport|card|cvv/i.test(action.target?.name ?? "");
}

/* ---------------- assessment core ---------------- */

export interface DriftContext {
  intent: TaskIntent;
  /** Hosts the agent itself navigated to (navigation chain). */
  allowedDomains: string[];
  /** Previous observation (null on first iteration). */
  prevSnapshot?: ObservationSnapshot | null;
  /** Last executed action + outcome (null before anything ran). */
  lastExecuted?: { action: AgentAction; ok: boolean } | null;
  /** The working tab changed under us (user switched tabs). */
  tabSwitched?: boolean;
}

function severityFor(score: number): DriftSeverity {
  for (const { at, severity } of SCORE_SEVERITY) {
    if (score >= at) return severity;
  }
  return "LOW";
}

function decisionFor(severity: DriftSeverity, driftTypes: DriftType[]): DriftDecision {
  if (driftTypes.length === 0) return "CONTINUE";
  switch (severity) {
    case "CRITICAL":
      return "ABORT";
    case "HIGH":
      return "PAUSE";
    case "MEDIUM":
      return "VERIFY";
    default:
      return "CONTINUE";
  }
}

interface ScoredSignals {
  components: DriftComponents;
  driftTypes: DriftType[];
  evidence: DriftEvidence[];
  severityFloor?: DriftSeverity;
  reasons: string[];
}

const SEVERITY_RANK: Record<DriftSeverity, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };

function raiseFloor(current: DriftSeverity | undefined, floor: DriftSeverity): DriftSeverity {
  if (!current) return floor;
  return SEVERITY_RANK[floor] > SEVERITY_RANK[current] ? floor : current;
}

function finalize(
  intent: TaskIntent,
  prevFingerprint: string,
  currentFingerprint: string,
  signals: ScoredSignals,
): DriftAssessment {
  const { components } = signals;
  const alignmentScore =
    Math.round(
      (components.goal * DRIFT_WEIGHTS.goal +
        components.state * DRIFT_WEIGHTS.state +
        components.domain * DRIFT_WEIGHTS.domain +
        components.action * DRIFT_WEIGHTS.action +
        components.context * DRIFT_WEIGHTS.context) *
        100,
    ) / 100;
  const driftScore = Math.round((1 - alignmentScore) * 100) / 100;
  let severity = severityFor(driftScore);
  if (signals.severityFloor) severity = raiseFloor(severity, signals.severityFloor);
  const decision = decisionFor(severity, signals.driftTypes);
  const reasons = [...signals.reasons];
  if (signals.driftTypes.length === 0) reasons.push("activity aligned with user intent");
  const event: IntentDriftEvent | null =
    decision === "CONTINUE" && signals.driftTypes.length === 0
      ? null
      : {
          eventId: `drift_${Date.now()}_${++eventSeq}`,
          taskId: intent.taskId,
          previousState: prevFingerprint,
          currentState: currentFingerprint,
          driftScore,
          alignmentScore,
          driftTypes: [...signals.driftTypes],
          evidence: signals.evidence.map((e) => ({ ...e })),
          severity,
          decision,
          timestamp: Date.now(),
        };
  return {
    decision,
    driftScore,
    alignmentScore,
    components,
    severity,
    driftTypes: [...signals.driftTypes],
    evidence: signals.evidence,
    reasons,
    event,
  };
}

/* ---------------- pre-action check ---------------- */

export interface PreActionInput {
  intent: TaskIntent;
  snapshot: ObservationSnapshot;
  action: AgentAction;
  ctx: DriftContext;
}

/**
 * Pre-action drift gate: does this proposed action still belong to the
 * user's task, on this page, right now? Pure + deterministic.
 */
export function checkPreActionDrift(input: PreActionInput): DriftAssessment {
  const { intent, snapshot, action, ctx } = input;
  // Terminal/resolution actions end the task — never drift.
  if (action.action === "finish" || action.action === "ask_user") {
    return clean(intent, snapshot, "resolution action ends the task");
  }
  // No DOM bridge: nothing semantic to compare (capability policy owns it).
  if (snapshot.pageType === "unsupported") {
    return clean(intent, snapshot, "internal page — capability policy governs");
  }

  const norm = normalizeBrowserState(snapshot);
  const prevNorm = ctx.prevSnapshot ? normalizeBrowserState(ctx.prevSnapshot) : null;
  const op = actionOpOf(action);
  const signals: ScoredSignals = {
    components: { goal: 1, state: 1, domain: 1, action: 1, context: 1 },
    driftTypes: [],
    evidence: [],
    reasons: [],
  };
  const flag = (
    type: DriftType,
    evidence: DriftEvidence,
    component: keyof DriftComponents,
    value: number,
    floor: DriftSeverity,
    reason: string,
  ) => {
    if (!signals.driftTypes.includes(type)) signals.driftTypes.push(type);
    signals.evidence.push(evidence);
    signals.components[component] = Math.min(signals.components[component], value);
    signals.severityFloor = raiseFloor(signals.severityFloor, floor);
    signals.reasons.push(reason);
  };

  // — domain: redirect without agent navigation is the hard signal —
  const host = norm.host;
  const prevHost = prevNorm ? hostOf(ctx.prevSnapshot!.url) : "";
  const known = ctx.allowedDomains.map((d) => d.toLowerCase());
  const lastNav =
    ctx.lastExecuted && ctx.lastExecuted.ok && ["navigate", "new_tab", "switch_tab"].includes(ctx.lastExecuted.action.action)
      ? ctx.lastExecuted.action
      : null;
  // Arrival means the observed host IS the navigation target. A stale
  // pre-commit page (still on the old host) is en route, not drift —
  // the verification layer judges whether navigation landed.
  const arrivedAtTarget = lastNav?.url ? hostOf(lastNav.url) === host : false;
  if (host && !known.includes(host)) {
    if ((lastNav && arrivedAtTarget) || ctx.tabSwitched) {
      // Arrived via our own navigation (or the user moved tabs): judge
      // relevance, not identity.
      const relevance = domainRelevance(intent, host);
      signals.components.domain = 0.4 + 0.6 * relevance;
      if (relevance < 0.5) {
        flag(
          "NAVIGATION_DRIFT",
          { type: "DOMAIN_MISMATCH", expected: known[0] ?? "(task origin)", observed: host, detail: "agent-navigated but off-task" },
          "domain",
          signals.components.domain,
          "MEDIUM",
          `navigated to off-task domain ${host}`,
        );
      } else {
        signals.reasons.push(`domain ${host} relevant to task`);
      }
    } else if (lastNav && !arrivedAtTarget) {
      signals.reasons.push("awaiting navigation commit");
    } else if (prevHost && prevHost !== host && !ctx.tabSwitched) {
      // Injection cues outrank everything: the page is steering.
      // Reward/financial overlays are hostile until proven otherwise.
      const injected = hasInjectionCues(snapshot);
      const hostileOverlay = norm.dialog === "reward" || norm.dialog === "financial";
      flag(
        "REDIRECT_DRIFT",
        {
          type: "UNEXPECTED_REDIRECT",
          expected: evidenceUrl(ctx.prevSnapshot!.url),
          observed: evidenceUrl(snapshot.url),
          detail: injected
            ? "unprompted domain change amid page instruction cues"
            : hostileOverlay
              ? "unprompted domain change with suspicious overlay"
              : "unprompted domain change",
        },
        "domain",
        0.1,
        injected ? "CRITICAL" : "HIGH",
        `unexpected redirect ${prevHost} → ${host}`,
      );
    } else if (!prevHost) {
      // First observation on an unknown host (deep link / restored tab).
      const relevance = domainRelevance(intent, host);
      signals.components.domain = 0.3 + 0.7 * relevance;
      if (relevance < 0.5) {
        flag(
          "NAVIGATION_DRIFT",
          { type: "DOMAIN_MISMATCH", expected: known[0] ?? "(task origin)", observed: host, detail: "first contact off-task" },
          "domain",
          signals.components.domain,
          "MEDIUM",
          `starting on off-task domain ${host}`,
        );
      }
    }
  }

  // — goal / task boundary: does this op belong? —
  if (!intent.allowedOps.includes(op)) {
    const transactional = op === "TRANSACTION" || op === "SUBMIT";
    flag(
      "TASK_BOUNDARY_DRIFT",
      {
        type: transactional ? "GOAL_ESCALATION" : "TASK_BOUNDARY_VIOLATION",
        expected: `boundary ${intent.boundary}`,
        observed: `operation ${op}`,
        detail: `task boundary is ${intent.boundary}`,
      },
      "goal",
      0.1,
      transactional ? "HIGH" : "MEDIUM",
      `operation ${op} outside task boundary ${intent.boundary}`,
    );
  } else {
    // In-boundary ops still score on target relevance for consequential
    // actions — but only the hijack lexicon (reward/claim/gift/…) can
    // fail a TRANSACTIONAL task's own commitment actions. Ordinary
    // "Pay now" targets are the task itself; Feature #3 confirms them.
    if ((op === "TRANSACTION" || op === "SUBMIT") && HIJACK_TARGET.test(action.target?.name ?? "")) {
      flag(
        "ACTION_DRIFT",
        { type: "OPERATION_MISMATCH", expected: "task-relevant commitment", observed: `reward-shaped ${op}`, detail: "hijack lexicon in target" },
        "action",
        0.15,
        "HIGH",
        `reward-shaped ${op} action does not match the task`,
      );
    }
    // Entity overlap credit for ordinary actions.
    const tokens = intentTokens(intent);
    const targetText = `${action.target?.name ?? ""} ${action.text ?? ""} ${action.url ?? ""}`;
    const overlap = tokenOverlap(tokens, targetText);
    signals.components.goal = op === "OTHER" ? 0.9 : 0.6 + 0.4 * Math.min(1, overlap * 2);
  }

  // — action vs page instructions (prompt-injection isolation) —
  if (hasInjectionCues(snapshot) && !intent.allowedOps.includes(op)) {
    // Already flagged as boundary drift; add the conflict evidence.
    signals.evidence.push({ type: "USER_INTENT_CONFLICT", expected: "user goal", observed: "page instruction", detail: "page carries instruction cues" });
    signals.severityFloor = raiseFloor(signals.severityFloor, "HIGH");
    signals.reasons.push("page instruction cues conflict with user intent");
  }
  if (hasInjectionCues(snapshot) && (op === "TRANSACTION" || isCredentialHarvestTarget(action))) {
    flag(
      "ACTION_DRIFT",
      { type: "USER_INTENT_CONFLICT", expected: "user goal", observed: `page-driven ${op}`, detail: "sensitive action amid injection cues" },
      "action",
      0.1,
      "CRITICAL",
      "page may be steering a sensitive action — intent conflict",
    );
  }

  // — state: page semantics vs task —
  if (norm.pageKind === "transaction" && !intent.transactional) {
    flag(
      "SEMANTIC_DRIFT",
      { type: "PAGE_SEMANTICS_MISMATCH", expected: `research/content for ${intent.boundary}`, observed: "transaction page", detail: "commitment surface during a non-transactional task" },
      "state",
      0.1,
      /payment|pay now|card details|billing/i.test(snapshot.visibleText) ? "CRITICAL" : "HIGH",
      "transaction page during non-transactional task",
    );
  }

  // — context: dialogs / overlays —
  if (norm.dialog === "reward") {
    const targetsIt =
      action.target?.name ? REWARD_CUES.test(action.target.name) : false;
    flag(
      "POPUP_DRIFT",
      { type: "DIALOG_STATE", expected: "task content", observed: "reward overlay", detail: targetsIt ? "action targets the overlay" : "overlay present" },
      "context",
      targetsIt ? 0.1 : 0.5,
      targetsIt ? "HIGH" : "MEDIUM",
      targetsIt ? "action targets an unrelated reward overlay" : "unrelated reward overlay present",
    );
    if (targetsIt && !signals.driftTypes.includes("ACTION_DRIFT")) {
      signals.driftTypes.push("ACTION_DRIFT");
      signals.evidence.push({ type: "OPERATION_MISMATCH", expected: "task action", observed: "reward claim", detail: "hijack pattern" });
    }
  } else if (norm.dialog === "financial" && !intent.transactional) {
    flag(
      "POPUP_DRIFT",
      { type: "DIALOG_STATE", expected: "task content", observed: "financial overlay", detail: "money dialog during non-transactional task" },
      "context",
      0.2,
      "HIGH",
      "financial overlay during non-transactional task",
    );
  } else if (norm.dialog === "auth") {
    const accountTask = /account|order|login|sign ?in|profile|history|booking/i.test(intent.goal);
    if (accountTask) {
      signals.components.context = 0.9;
      signals.reasons.push("login wall expected for account task");
    } else {
      flag(
        "UI_DRIFT",
        { type: "DIALOG_STATE", expected: "public content", observed: "login wall", detail: "gated content on a public task" },
        "context",
        0.5,
        "MEDIUM",
        "unexpected login wall",
      );
    }
  } else if (norm.dialog === "cookie") {
    signals.components.context = Math.min(signals.components.context, 0.9);
    signals.reasons.push("harmless cookie/consent notice");
  } else if (norm.dialog === "generic" && norm.dialogCount > 0) {
    flag(
      "UI_DRIFT",
      { type: "DIALOG_STATE", expected: "task content", observed: "unclassified dialog", detail: "verify before interacting" },
      "context",
      0.6,
      "LOW",
      "unclassified dialog present",
    );
  }
  if (norm.loading) {
    signals.components.context = Math.min(signals.components.context, 0.8);
  }

  return finalize(intent, prevNorm ? prevNorm.fingerprint : "(start)", norm.fingerprint, signals);
}

function clean(intent: TaskIntent, snapshot: ObservationSnapshot, reason: string): DriftAssessment {
  void intent;
  void snapshot;
  return {
    decision: "CONTINUE",
    driftScore: 0,
    alignmentScore: 1,
    components: { goal: 1, state: 1, domain: 1, action: 1, context: 1 },
    severity: "LOW",
    driftTypes: [],
    evidence: [],
    reasons: [reason],
    event: null,
  };
}

/* ---------------- post-action check ---------------- */

export interface PostActionInput {
  intent: TaskIntent;
  /** Pre-action snapshot. */
  prevSnapshot: ObservationSnapshot;
  /** Fresh post-action snapshot. */
  freshSnapshot: ObservationSnapshot;
  lastAction: AgentAction;
  actionOk: boolean;
  ctx: DriftContext;
}

/**
 * Post-action drift check: did the world move somewhere the task did
 * not authorize? Runs on the fresh observation with the same engine.
 */
export function checkPostActionDrift(input: PostActionInput): DriftAssessment {
  const { intent, prevSnapshot, freshSnapshot, lastAction, actionOk, ctx } = input;
  if (freshSnapshot.pageType === "unsupported") {
    return clean(intent, freshSnapshot, "post-action page not observable — next loop governs");
  }
  const norm = normalizeBrowserState(freshSnapshot);
  const prevNorm = normalizeBrowserState(prevSnapshot);
  const signals: ScoredSignals = {
    components: { goal: 1, state: 1, domain: 1, action: 1, context: 1 },
    driftTypes: [],
    evidence: [],
    reasons: [],
  };
  const flag = (
    type: DriftType,
    evidence: DriftEvidence,
    component: keyof DriftComponents,
    value: number,
    floor: DriftSeverity,
    reason: string,
  ) => {
    if (!signals.driftTypes.includes(type)) signals.driftTypes.push(type);
    signals.evidence.push(evidence);
    signals.components[component] = Math.min(signals.components[component], value);
    signals.severityFloor = raiseFloor(signals.severityFloor, floor);
    signals.reasons.push(reason);
  };

  const prevHost = hostOf(prevSnapshot.url);
  const host = norm.host;
  const navigated = ["navigate", "new_tab", "switch_tab", "back", "forward", "reload"].includes(lastAction.action);
  const known = ctx.allowedDomains.map((d) => d.toLowerCase());

  if (host && prevHost && host !== prevHost && !(navigated && actionOk)) {
    const injected = hasInjectionCues(freshSnapshot);
    const hostileOverlay = norm.dialog === "reward" || norm.dialog === "financial";
    flag(
      "REDIRECT_DRIFT",
      { type: "UNEXPECTED_REDIRECT", expected: evidenceUrl(prevSnapshot.url), observed: evidenceUrl(freshSnapshot.url), detail: "domain changed without agent navigation" },
      "domain",
      0.1,
      injected ? "CRITICAL" : "HIGH",
      `domain changed without agent navigation (${prevHost} → ${host})${hostileOverlay ? " with suspicious overlay" : ""}`,
    );
  } else if (host && !known.includes(host) && !(navigated && actionOk)) {
    // No navigation explains this host: only relevant domains pass
    // silently (first-contact deep links still get one VERIFY).
    const relevance = domainRelevance(intent, host);
    signals.components.domain = 0.3 + 0.7 * relevance;
    if (relevance < 0.5) {
      flag(
        "NAVIGATION_DRIFT",
        { type: "DOMAIN_MISMATCH", expected: known[0] ?? "(task origin)", observed: host, detail: "off-task domain without navigation" },
        "domain",
        signals.components.domain,
        "MEDIUM",
        `off-task domain ${host} without agent navigation`,
      );
    } else {
      signals.reasons.push(`domain ${host} relevant to task`);
    }
  } else if (host) {
    signals.reasons.push(`domain ${host} consistent`);
  }

  // Transaction/auth surfaces appearing after a non-transactional action.
  if (norm.pageKind === "transaction" && !intent.transactional) {
    flag(
      "SEMANTIC_DRIFT",
      { type: "PAGE_SEMANTICS_MISMATCH", expected: `research/content for ${intent.boundary}`, observed: "transaction page", detail: "landed on commitment surface" },
      "state",
      0.1,
      /payment|pay now|card details|billing/i.test(freshSnapshot.visibleText) ? "CRITICAL" : "HIGH",
      "landed on transaction page during non-transactional task",
    );
  } else if (norm.pageKind === "auth" && !/account|order|login|sign ?in|profile|history|booking/i.test(intent.goal)) {
    flag(
      "UI_DRIFT",
      { type: "DIALOG_STATE", expected: "public content", observed: "login wall", detail: "gated after action" },
      "context",
      0.5,
      "MEDIUM",
      "login wall appeared after action",
    );
  } else {
    signals.components.state = 0.95;
  }

  if (norm.dialog === "reward") {
    flag(
      "POPUP_DRIFT",
      { type: "DIALOG_STATE", expected: "task content", observed: "reward overlay", detail: "appeared after action" },
      "context",
      0.4,
      "HIGH",
      "reward overlay appeared after action",
    );
  } else if (norm.dialog === "financial" && !intent.transactional) {
    flag(
      "POPUP_DRIFT",
      { type: "DIALOG_STATE", expected: "task content", observed: "financial overlay", detail: "appeared after action" },
      "context",
      0.2,
      "HIGH",
      "financial overlay appeared after action",
    );
  }

  // Goal component: the executed action's op vs boundary.
  const op = actionOpOf(lastAction);
  if (!intent.allowedOps.includes(op)) {
    flag(
      "TASK_DRIFT",
      { type: "TASK_BOUNDARY_VIOLATION", expected: `boundary ${intent.boundary}`, observed: `executed ${op}`, detail: "executed action outside boundary" },
      "goal",
      0.15,
      op === "TRANSACTION" ? "HIGH" : "MEDIUM",
      `executed ${op} outside task boundary ${intent.boundary}`,
    );
  } else {
    signals.components.goal = 0.95;
    signals.components.action = 0.95;
  }

  return finalize(intent, prevNorm.fingerprint, norm.fingerprint, signals);
}

/* ---------------- completion boundary ---------------- */

/**
 * A completion claim is only valid inside the task boundary: arriving
 * at checkout/payment/account-deletion (or an unknown domain) during a
 * non-transactional task is DRIFT, not success.
 */
export function isCompletionWithinBoundary(
  intent: TaskIntent,
  snapshot: ObservationSnapshot,
  allowedDomains: string[],
): { ok: boolean; reason?: string } {
  if (snapshot.pageType === "unsupported") return { ok: true };
  const norm = normalizeBrowserState(snapshot);
  if (norm.pageKind === "transaction" && !intent.transactional) {
    return { ok: false, reason: `completion claimed on a transaction page during ${intent.boundary} task` };
  }
  const host = norm.host;
  if (host && !allowedDomains.map((d) => d.toLowerCase()).includes(host) && domainRelevance(intent, host) < 0.5) {
    return { ok: false, reason: `completion claimed on off-task domain ${host}` };
  }
  return { ok: true };
}
