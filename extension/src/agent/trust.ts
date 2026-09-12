/* ------------------------------------------------------------------ *
 * VisualTrust — LOCAL webpage/environment trust assessment (Feature #6).
 *
 * Answers ONE question: "is the current environment trustworthy enough
 * to keep operating?" It NEVER authorizes actions (Feature #3), never
 * judges task alignment (Feature #4) and never touches the network.
 *
 * Score semantics: 0–100 is an INTERNAL risk-oriented assessment, NOT
 * a probability. Higher = stronger positive evidence; lower = stronger
 * suspicious evidence. An aggregate can never outvote a critical
 * security signal (centralized overrides below).
 *
 * Inputs are all local + value-free: domain/navigation facts, lexical
 * presence cues (never values), and supporting context consumed from
 * Features #1/#3/#4/#5. Pure + deterministic.
 * ------------------------------------------------------------------ */

import type { ObservationSnapshot } from "@/shared/messages";
import { scanText } from "@/privacy/fusion";

export type TrustLevel = "VERY_HIGH" | "HIGH" | "CAUTION" | "LOW" | "CRITICAL";
export type TrustDecision = "CONTINUE" | "VERIFY" | "WARN" | "PAUSE" | "BLOCK";
export type TrustTrend = "STABLE" | "IMPROVING" | "DECLINING" | "COLLAPSE";
export type TrustSignalSource = "URL" | "NAVIGATION" | "DOM" | "VISUAL" | "SEMANTIC" | "INTERACTION" | "CONTEXT";
export type TrustSignalSeverity = "POSITIVE" | "NEUTRAL" | "SUSPICIOUS" | "CRITICAL";

export interface TrustSignal {
  type: string;
  severity: TrustSignalSeverity;
  source: TrustSignalSource;
  /** Signed class contribution in score points (before weights). */
  contribution: number;
  /** Stable reason code — never a value (see SAFE_EVIDENCE below). */
  evidenceCode: string;
}

export interface VisualTrustAssessment {
  score: number;
  level: TrustLevel;
  signals: TrustSignal[];
  decision: TrustDecision;
  trend: TrustTrend;
  timestamp: number;
}

/** Centralized weights — the ONLY trust formula (sums to 1). */
export const TRUST_WEIGHTS = {
  domain: 0.25,
  navigation: 0.15,
  visual: 0.15,
  semantic: 0.2,
  taskContext: 0.15,
  interaction: 0.1,
} as const;

/** Centralized policy bands (NOT probabilities). */
export const TRUST_BANDS: Array<{ min: number; level: TrustLevel }> = [
  { min: 90, level: "VERY_HIGH" },
  { min: 75, level: "HIGH" },
  { min: 50, level: "CAUTION" },
  { min: 25, level: "LOW" },
  { min: 0, level: "CRITICAL" },
];

export interface TrustContext {
  taskId: string;
  url: string;
  prevUrl?: string | null;
  /** Hosts the task owns (seed + agent navigation chain). */
  expectedHosts: string[];
  /** Current host arrived via the agent's own navigation. */
  navigatedByAgent: boolean;
  /** Host changed without agent navigation (BEFORE this assessment). */
  redirectHop: boolean;
  /** Cumulative unprompted cross-host hops observed this task. */
  redirectCount: number;
  snapshot: ObservationSnapshot;
  /** Feature #4 supporting context (consumed, never recomputed). */
  driftScore: number | null;
  driftSeverity?: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" | null;
  /** Feature #3 supporting context: latest action-risk level. */
  safetyRisk?: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" | null;
  /** Feature #5 supporting context (capped influence, never authority). */
  memoryKnownStructure: boolean;
  memoryConfidence: number;
  /** Brand tokens from the user goal/entities (impersonation check). */
  brandTokens: string[];
  /** Whether the task explicitly involves commitment (buy/pay/submit). */
  transactional: boolean;
  /** The current host is the run's origin tab (user context, not evidence). */
  isOrigin: boolean;
  /** Recent op labels for interaction normalcy (structural names only). */
  recentOps: string[];
  /** Prior scores this task, oldest→newest (trend lives here). */
  recentScores: number[];
  now?: number;
}

/* ---------------- local lexical presence cues ---------------- */
/* Presence only — matched words are never stored or returned. */

const CREDENTIAL_CUES = /password|passphrase|sign ?in|log ?in|create (an )?account|verify (your )?identity|account verification/i;
const OTP_CUES = /\botp\b|one[- ]time (password|code)|verification code|enter the code|6[- ]digit code/i;
const PAYMENT_CUES = /payment|checkout|place order|pay now|card details|billing|order summary|upi (id|payment)|net ?banking/i;
const REWARD_CUES = /congratulations|you (have )?won|claim (now|reward|prize)|free (prize|gift|money)|lottery|winner|prize/i;
const URGENT_CUES = /urgent|immediately|act now|limited time|suspended|expires (today|soon)|verify immediately|final warning|account (will be )?locked/i;
const INJECTION_CUES =
  /ignore (all |any |the |previous |prior )?(previous |prior |earlier )?(instructions|instruction|request|prompt)|disregard.*instructions|upload your (credentials|identity)|enter your bank details|claim this reward/i;
const UPLOAD_CUES = /upload|attach (a |an )?(file|document|photo|identity)|select file|choose file|drag.?and.?drop/i;

function hostOf(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function stripWww(host: string): string {
  return host.replace(/^www\./, "");
}

/** Security-aware host equivalence: www-folding only, never across
 * registrable boundaries (evil.example.com ≠ example.com). */
function sameSite(a: string, b: string): boolean {
  if (!a || !b) return false;
  return stripWww(a) === stripWww(b);
}

/** Tiny edit distance for lookalike-host detection (local, no deps). */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > 2) return 3;
  const dp: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const next = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = next;
    }
  }
  return dp[n];
}

function clampScore(n: number): number {
  if (!Number.isFinite(n)) return 50;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function levelFor(score: number): TrustLevel {
  for (const band of TRUST_BANDS) {
    if (score >= band.min) return band.level;
  }
  return "CRITICAL";
}

/** Trend from prior scores + current (needs ≥2 priors to move). */
export function trustTrend(recentScores: number[], current: number): TrustTrend {
  const window = [...recentScores.slice(-4), current];
  if (window.length < 3) return "STABLE";
  const first = window[0];
  const max = Math.max(...window);
  if (max - current >= 40) return "COLLAPSE";
  const delta = current - first;
  if (delta <= -15) return "DECLINING";
  if (delta >= 10) return "IMPROVING";
  return "STABLE";
}

/* ---------------- signal collectors (one per class) ---------------- */

interface ClassResult {
  score: number;
  signals: TrustSignal[];
}

function sig(
  type: string,
  severity: TrustSignalSeverity,
  source: TrustSignalSource,
  contribution: number,
  evidenceCode: string,
): TrustSignal {
  return { type, severity, source, contribution, evidenceCode };
}

function domainSignals(ctx: TrustContext, host: string): ClassResult {
  const signals: TrustSignal[] = [];
  let score = 70;
  if (!host) {
    signals.push(sig("missing_domain", "SUSPICIOUS", "URL", -10, "MISSING_DOMAIN"));
    return { score: 50, signals };
  }
  const expected = ctx.expectedHosts.map((h) => h.toLowerCase());
  const known = expected.some((h) => sameSite(h, host));
  if (known) {
    score += 15;
    signals.push(sig("expected_domain", "POSITIVE", "URL", 15, "EXPECTED_DOMAIN"));
  } else if (ctx.navigatedByAgent) {
    // Agent-navigated unknown host: mild penalty, relevance judged
    // by the task-context class, not here.
    score -= 5;
    signals.push(sig("agent_navigated_unknown_domain", "NEUTRAL", "URL", -5, "UNKNOWN_DOMAIN"));
  } else {
    score -= 20;
    signals.push(sig("unknown_domain", "SUSPICIOUS", "URL", -20, "UNKNOWN_DOMAIN"));
  }
  // Lookalike host vs user-expected brand tokens (phishing shape).
  const bare = stripWww(host).split(".")[0] ?? "";
  for (const brand of ctx.brandTokens) {
    const b = brand.toLowerCase().replace(/^www\./, "").split(".")[0] ?? "";
    if (b.length >= 4 && bare && bare !== b && editDistance(bare, b) <= 2) {
      score -= 25;
      signals.push(sig("lookalike_domain", "CRITICAL", "URL", -25, "BRAND_DOMAIN_MISMATCH"));
      break;
    }
  }
  // NOTE: HTTPS presence is deliberately NOT a positive signal (RULE 1).
  return { score: clampScore(score), signals };
}

function navigationSignals(ctx: TrustContext, host: string, prevHost: string): ClassResult {
  const signals: TrustSignal[] = [];
  let score = 70;
  if (ctx.redirectHop && prevHost && host && prevHost !== host) {
    const related = sameSite(prevHost, host) || ctx.navigatedByAgent;
    if (related) {
      score += 5;
      signals.push(sig("expected_navigation", "POSITIVE", "NAVIGATION", 5, "EXPECTED_NAVIGATION"));
    } else {
      const penalty = ctx.redirectCount >= 2 ? -25 : -15;
      score += penalty;
      signals.push(
        sig("unexpected_redirect", "SUSPICIOUS", "NAVIGATION", penalty, ctx.redirectCount >= 2 ? "MULTIPLE_REDIRECTS" : "UNKNOWN_REDIRECT"),
      );
    }
  } else if (!ctx.redirectHop) {
    score += 10;
    signals.push(sig("stable_origin", "POSITIVE", "NAVIGATION", 10, "EXPECTED_NAVIGATION"));
  }
  if (ctx.redirectCount >= 3) {
    score -= 10;
    signals.push(sig("redirect_chain", "SUSPICIOUS", "NAVIGATION", -10, "MULTIPLE_REDIRECTS"));
  }
  return { score: clampScore(score), signals };
}

function visualSignals(ctx: TrustContext): ClassResult {
  // Structural visual evidence from existing perception (roles only —
  // no pixels, no screenshots leave or enter this module).
  const signals: TrustSignal[] = [];
  let score = 70;
  const els = ctx.snapshot.elements.filter((e) => e.visible);
  const dialogs = els.filter((e) => e.role === "dialog" || e.role === "alertdialog");
  if (dialogs.length === 0) {
    score += 5;
    signals.push(sig("no_overlay", "POSITIVE", "VISUAL", 5, "NORMAL_UI"));
  } else if (dialogs.length === 1) {
    score -= 5;
    signals.push(sig("single_overlay", "NEUTRAL", "VISUAL", -5, "SUSPICIOUS_POPUP"));
  } else {
    score -= 15;
    signals.push(sig("stacked_overlays", "SUSPICIOUS", "VISUAL", -15, "SUSPICIOUS_POPUP"));
  }
  // Brand/domain consistency: title names a brand the host does not own.
  const title = `${ctx.snapshot.title}`;
  for (const brand of ctx.brandTokens) {
    const b = brand.toLowerCase();
    if (b.length >= 4 && title.toLowerCase().includes(b) && !stripWww(hostOf(ctx.url)).includes(b)) {
      score -= 15;
      signals.push(sig("brand_visual_mismatch", "SUSPICIOUS", "VISUAL", -15, "BRAND_DOMAIN_MISMATCH"));
      break;
    }
  }
  return { score: clampScore(score), signals };
}

function semanticSignals(ctx: TrustContext, hostKnown: boolean): ClassResult {
  const signals: TrustSignal[] = [];
  let score = 70;
  const text = `${ctx.snapshot.title} \n ${ctx.snapshot.visibleText}`;
  const names = ctx.snapshot.elements
    .filter((e) => e.visible)
    .map((e) => e.name)
    .join(" \n ");
  const combined = `${text} \n ${names}`;
  const hasPasswordField = ctx.snapshot.elements.some(
    (e) => e.visible && (e.type === "password" || /password/i.test(e.name)),
  );
  // Feature #1 context: sensitive PII kinds sitting on an UNKNOWN host
  // is exposure-shaped; on a known host it is merely content.
  const piiKinds = new Set(scanText(combined).map((f) => f.type.toUpperCase()));
  if (!hostKnown && ["CREDIT_CARD", "AADHAAR", "PAN", "SSN", "PASSPORT"].some((k) => piiKinds.has(k))) {
    score -= 10;
    signals.push(sig("sensitive_exposure", "SUSPICIOUS", "SEMANTIC", -10, "SENSITIVE_EXPOSURE"));
  }

  if (CREDENTIAL_CUES.test(combined) || hasPasswordField) {
    score -= 12;
    signals.push(sig("credential_request", "SUSPICIOUS", "SEMANTIC", -12, "CREDENTIAL_REQUEST"));
  }
  if (OTP_CUES.test(combined)) {
    score -= 12;
    signals.push(sig("otp_request", "SUSPICIOUS", "SEMANTIC", -12, "OTP_REQUEST"));
  }
  if (PAYMENT_CUES.test(combined)) {
    score -= 12;
    signals.push(sig("payment_request", "SUSPICIOUS", "SEMANTIC", -12, "PAYMENT_REQUEST"));
  }
  if (REWARD_CUES.test(combined)) {
    score -= 15;
    signals.push(sig("reward_lure", "SUSPICIOUS", "SEMANTIC", -15, "SUSPICIOUS_POPUP"));
  }
  if (URGENT_CUES.test(combined)) {
    score -= 10;
    signals.push(sig("urgent_language", "SUSPICIOUS", "SEMANTIC", -10, "URGENT_SECURITY_LANGUAGE"));
  }
  if (INJECTION_CUES.test(combined)) {
    score -= 20;
    signals.push(sig("page_instruction_injection", "CRITICAL", "SEMANTIC", -20, "PAGE_INSTRUCTION_CONFLICT"));
  }
  if (UPLOAD_CUES.test(names)) {
    score -= 8;
    signals.push(sig("upload_solicitation", "SUSPICIOUS", "SEMANTIC", -8, "SUSPICIOUS_UPLOAD"));
  }
  if (signals.length === 0) {
    score += 10;
    signals.push(sig("neutral_semantics", "POSITIVE", "SEMANTIC", 10, "NORMAL_UI"));
  }
  return { score: clampScore(score), signals };
}

function taskContextSignals(ctx: TrustContext, snapshotKinds: { transactionalPage: boolean; authWall: boolean }): ClassResult {
  const signals: TrustSignal[] = [];
  let score = 70;
  // Drift consumed (never recomputed): misalignment drags trust.
  if (ctx.driftScore != null && Number.isFinite(ctx.driftScore)) {
    const drag = -Math.round(ctx.driftScore * 25);
    score += drag;
    signals.push(
      sig("intent_alignment", ctx.driftScore >= 0.55 ? "SUSPICIOUS" : "POSITIVE", "CONTEXT", drag, "TASK_CONTEXT_MISMATCH"),
    );
  }
  if (snapshotKinds.transactionalPage && !ctx.transactional) {
    score -= 20;
    signals.push(sig("transaction_out_of_task", "SUSPICIOUS", "CONTEXT", -20, "TASK_CONTEXT_MISMATCH"));
  } else if (snapshotKinds.transactionalPage && ctx.transactional) {
    score += 5;
    signals.push(sig("transaction_in_task", "POSITIVE", "CONTEXT", 5, "EXPECTED_TASK_STATE"));
  }
  if (snapshotKinds.authWall) {
    score -= 5;
    signals.push(sig("auth_wall_present", "NEUTRAL", "CONTEXT", -5, "LOGIN_WALL"));
  }
  if (signals.length === 0) {
    score += 10;
    signals.push(sig("task_aligned_context", "POSITIVE", "CONTEXT", 10, "EXPECTED_TASK_STATE"));
  }
  return { score: clampScore(score), signals };
}

function interactionSignals(ctx: TrustContext): ClassResult {
  const signals: TrustSignal[] = [];
  let score = 70;
  // Routine op vocabulary matches drift actionOpOf (UPPERCASE); anything
  // else is unexpected by construction. TRANSACTION is never "routine".
  const routine = new Set(["NAVIGATE", "SEARCH", "INPUT", "SUBMIT", "FILTER", "VIEW", "COLLECT", "OTHER"]);
  const sensitive = new Set(["TRANSACTION"]);
  const ops = ctx.recentOps.slice(-6).map((o) => String(o).toUpperCase());
  if (ops.length === 0) {
    signals.push(sig("no_interaction_yet", "NEUTRAL", "INTERACTION", 0, "NORMAL_UI"));
    return { score, signals };
  }
  const odd = ops.filter((o) => !routine.has(o));
  if (odd.length === 0) {
    score += 10;
    signals.push(sig("routine_interactions", "POSITIVE", "INTERACTION", 10, "NORMAL_UI"));
  } else {
    const hit = odd.some((o) => sensitive.has(o));
    score += hit ? -15 : -5;
    signals.push(sig("unusual_interaction", hit ? "CRITICAL" : "SUSPICIOUS", "INTERACTION", hit ? -15 : -5, "UNEXPECTED_INTERACTION"));
  }
  return { score: clampScore(score), signals };
}

/* ---------------- critical overrides (caps) ---------------- */

interface Override {
  cap: number;
  code: string;
  when: (facts: {
    hostKnown: boolean;
    isOrigin: boolean;
    credential: boolean;
    otp: boolean;
    urgent: boolean;
    paymentOutOfTask: boolean;
    identityUploadUnrelated: boolean;
    brandMismatch: boolean;
    injection: boolean;
    rewardLure: boolean;
    rewardLureUnknown: boolean;
  }) => boolean;
}

/** Centralized critical-override policy: caps the aggregate, never below. */
const OVERRIDES: Override[] = [
  // A bare credential form is WARN-level on its own; WITH an aggravator
  // (OTP, urgency, injection, reward lure) on an unknown host it is a
  // credential trap. Origin context alone never clears an aggravated case.
  { cap: 24, code: "UNKNOWN_DOMAIN_CREDENTIAL", when: (f) => !f.hostKnown && f.credential && (f.otp || f.urgent || f.injection || f.rewardLure) },
  { cap: 24, code: "UNKNOWN_DOMAIN_OTP", when: (f) => !f.hostKnown && f.otp },
  { cap: 24, code: "UNEXPECTED_PAYMENT", when: (f) => f.paymentOutOfTask },
  { cap: 49, code: "IDENTITY_UPLOAD_UNRELATED", when: (f) => f.identityUploadUnrelated },
  { cap: 49, code: "BRAND_MISMATCH_CREDENTIAL", when: (f) => f.brandMismatch && f.credential },
  { cap: 24, code: "INJECTION_SENSITIVE", when: (f) => f.injection && (f.credential || f.otp || f.paymentOutOfTask) },
  { cap: 49, code: "REWARD_LURE_UNKNOWN", when: (f) => !f.hostKnown && f.rewardLureUnknown },
  // Navigated-to unknown login forms (not the user's origin tab) pause
  // even without aggravators — first contact there is unverified.
  { cap: 49, code: "CREDENTIAL_UNVERIFIED", when: (f) => !f.hostKnown && !f.isOrigin && f.credential },
];

/* ---------------- main assessment ---------------- */

/**
 * Assess the current environment. Pure + deterministic; invalid input
 * fails safe (mid score + VERIFY, never NaN, never a crash).
 */
export function assessTrust(ctx: TrustContext): VisualTrustAssessment {
  const now = ctx.now ?? Date.now();
  const invalid =
    !ctx || typeof ctx.url !== "string" || !ctx.snapshot || typeof ctx.snapshot !== "object";
  const host = invalid ? "" : hostOf(ctx.url);
  const prevHost = invalid ? "" : hostOf(ctx.prevUrl ?? undefined);
  const known = invalid ? false : ctx.expectedHosts.map((h) => h.toLowerCase()).some((h) => sameSite(h, host));

  const domain = invalid
    ? { score: 50, signals: [sig("invalid_input", "SUSPICIOUS", "URL", 0, "INVALID_INPUT")] }
    : domainSignals(ctx, host);
  const navigation = invalid
    ? { score: 50, signals: [] as TrustSignal[] }
    : navigationSignals(ctx, host, prevHost);
  const visual = invalid ? { score: 50, signals: [] as TrustSignal[] } : visualSignals(ctx);
  const semantic = invalid ? { score: 50, signals: [] as TrustSignal[] } : semanticSignals(ctx, known);

  const text = invalid ? "" : `${ctx.snapshot.title} \n ${ctx.snapshot.visibleText}`;
  const transactionalPage = !invalid && PAYMENT_CUES.test(text);
  const authWall = !invalid && /sign in to continue|log ?in to continue|log ?in required|create an account|sign up to continue/i.test(text);
  const taskContext = invalid
    ? { score: 50, signals: [] as TrustSignal[] }
    : taskContextSignals(ctx, { transactionalPage, authWall });
  const interaction = invalid ? { score: 50, signals: [] as TrustSignal[] } : interactionSignals(ctx);

  let score =
    domain.score * TRUST_WEIGHTS.domain +
    navigation.score * TRUST_WEIGHTS.navigation +
    visual.score * TRUST_WEIGHTS.visual +
    semantic.score * TRUST_WEIGHTS.semantic +
    taskContext.score * TRUST_WEIGHTS.taskContext +
    interaction.score * TRUST_WEIGHTS.interaction;

  // Feature #5 as a bounded positive: memory may add context, never
  // authority. Applied BEFORE the critical overrides below, which cap
  // the FINAL score — nothing can lift a capped score back up.
  let memoryBonus = 0;
  if (!invalid && ctx.memoryKnownStructure) {
    memoryBonus = Math.min(5, Math.round(ctx.memoryConfidence * 5));
    score += memoryBonus;
  }

  // Critical overrides: caps, evaluated on evidence — never on vibes.
  // They run LAST (after the memory bonus) so nothing can lift a capped
  // score back above a critical threshold (RULE: memory ≠ authority).
  const names = invalid
    ? ""
    : ctx.snapshot.elements
        .filter((e) => e.visible)
        .map((e) => e.name)
        .join(" \n ");
  const combined = `${text} \n ${names}`;
  const credential = !invalid && (CREDENTIAL_CUES.test(combined) || ctx.snapshot.elements.some((e) => e.visible && e.type === "password"));
  const otp = !invalid && OTP_CUES.test(combined);
  const paymentOutOfTask = !invalid && transactionalPage && !ctx.transactional;
  const identityUploadUnrelated =
    !invalid && /upload|attach/i.test(names) && /identity|document|passport|credential/i.test(combined);
  const brandMismatch =
    !invalid &&
    ctx.brandTokens.some((brand) => {
      const b = brand.toLowerCase().replace(/^www\./, "").split(".")[0] ?? "";
      const bare = stripWww(host).split(".")[0] ?? "";
      return b.length >= 4 && bare.length >= 4 && bare !== b && (editDistance(bare, b) <= 2 || titleNamesBrand(ctx.snapshot.title, b));
    }) &&
    credential;
  const injection = !invalid && INJECTION_CUES.test(combined);
  const appliedCaps: string[] = [];
  const isOrigin = !invalid && ctx.isOrigin;
  for (const override of OVERRIDES) {
    if (
      override.when({
        hostKnown: known,
        isOrigin,
        credential,
        otp,
        urgent: !invalid && URGENT_CUES.test(combined),
        paymentOutOfTask,
        identityUploadUnrelated,
        brandMismatch,
        injection,
        rewardLure: !invalid && REWARD_CUES.test(combined),
        rewardLureUnknown: !known && REWARD_CUES.test(combined),
      })
    ) {
      if (score > override.cap) {
        score = override.cap;
        appliedCaps.push(override.code);
      }
    }
  }

  score = clampScore(score);
  const level = levelFor(score);
  const trend = trustTrend(ctx.recentScores ?? [], score);

  let decision: TrustDecision;
  switch (level) {
    case "VERY_HIGH":
      decision = "CONTINUE";
      break;
    case "HIGH":
      decision = trend === "DECLINING" || trend === "COLLAPSE" ? "VERIFY" : "CONTINUE";
      break;
    case "CAUTION":
      decision =
        (ctx.driftScore != null && ctx.driftScore >= 0.35) || trend === "DECLINING" || trend === "COLLAPSE"
          ? "VERIFY"
          : "WARN";
      break;
    case "LOW":
      decision = "PAUSE";
      break;
    default:
      decision = "BLOCK";
  }
  if (invalid) decision = "VERIFY";
  // Severe misalignment keeps trust vigilant even in a benign-looking
  // environment (Feature #4 still owns the pause; trust just watches).
  if (
    (ctx.driftSeverity === "HIGH" || ctx.driftSeverity === "CRITICAL") &&
    (decision === "CONTINUE" || decision === "WARN")
  ) {
    decision = "VERIFY";
  }
  // Collapse is supporting evidence for conservatism, never sole proof.
  if (trend === "COLLAPSE" && (decision === "CONTINUE" || decision === "WARN" || decision === "VERIFY")) {
    decision = "PAUSE";
  }

  const signals = [...domain.signals, ...navigation.signals, ...visual.signals, ...semantic.signals, ...taskContext.signals, ...interaction.signals];
  if (memoryBonus > 0) {
    signals.push(sig("memory_context", "POSITIVE", "CONTEXT", memoryBonus, "KNOWN_STRUCTURE"));
  }
  for (const code of appliedCaps) {
    signals.push(sig("critical_override", "CRITICAL", "CONTEXT", 0, code));
  }
  return { score, level, signals, decision, trend, timestamp: now };
}

/** Title names the brand while the host does not own it. */
function titleNamesBrand(title: string, brand: string): boolean {
  if (!title || brand.length < 4) return false;
  return title.toLowerCase().includes(brand);
}
