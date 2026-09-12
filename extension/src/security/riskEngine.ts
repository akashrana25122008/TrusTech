/* ------------------------------------------------------------------ *
 * Action Risk Engine — evaluates every action before it executes.
 * Levels escalate from advisory (low) through confirmation-gated
 * (medium) to hard-require-human (high). High-risk actions never
 * execute without an explicit user grant.
 * ------------------------------------------------------------------ */

export type RiskLevel = "low" | "medium" | "high";

export interface RiskAdvice {
  level: RiskLevel;
  needsConfirmation: boolean;
  allow: boolean;
  reasons: string[];
  /** Human-readable short label shown in the confirm bar. */
  label: string;
}

export interface ActionContext {
  /** Action kind (click/type/scroll/select/newTab/closeTab/reload/…). */
  command: string;
  /** Use-case hint derived from the task, e.g. "buy train ticket". */
  intentPhrase?: string;
  /** Domain the action targets, if known. */
  domain?: string;
  /** True once the current task step is explicitly confirmed by the user. */
  userConfirmed?: boolean;
  /** True if the outbound traffic it enables failed privacy inspection. */
  privacyBlocked?: boolean;
}

const TRUSTED_DOMAINS = new Set([
  "youtube.com",
  "mail.google.com",
  "google.com",
  "amazon.com",
  "amazon.in",
  "erail.in",
  "irctc.co.in",
]);

const DESTRUCTIVE = /\b(delete|remove|cancel account|close account|unsubscribe|wipe|erase|terminate)\b/i;
const FINANCIAL = /\b(pay|checkout|purchase|buy|order|book|confirm booking|transfer|pay now|payment)\b/i;
const CREDENTIAL = /\b(login|sign in|password|otp|credit card|cvv|card number)\b/i;

function classifyLevel(ctx: ActionContext): { level: RiskLevel; reasons: string[] } {
  const reasons: string[] = [];
  let level: RiskLevel = "low";

  const phrase = ctx.intentPhrase ?? "";
  const command = ctx.command;

  if (ctx.privacyBlocked) {
    level = "high";
    reasons.push("Outbound traffic failed privacy inspection");
  }

  if (DESTRUCTIVE.test(phrase)) {
    level = "high";
    reasons.push("Destructive action (delete/removal)");
  } else if (FINANCIAL.test(phrase) && (command === "click" || command === "type")) {
    level = "high";
    reasons.push("Financial transaction or checkout");
  } else if (CREDENTIAL.test(phrase) && command === "type") {
    level = "high";
    reasons.push("Credential or payment-field autofill");
  }

  if (command === "closeTab") {
    level = level === "high" ? level : "medium";
    reasons.push("Closing the active tab");
  }

  if (ctx.domain && !TRUSTED_DOMAINS.has(ctx.domain)) {
    if (level !== "high") level = "medium";
    reasons.push(`Untrusted domain: ${ctx.domain}`);
  }

  if (!ctx.domain && command === "click") {
    if (level !== "high") level = "medium";
    reasons.push("Destination unknown");
  }

  if (level === "low") reasons.push("Low-risk interaction");
  return { level, reasons };
}

export function assessAction(ctx: ActionContext): RiskAdvice {
  const { level, reasons } = classifyLevel(ctx);

  // Explicit user confirmation downgrades nothing, but allows execution.
  const allow = !ctx.privacyBlocked && (level !== "high" || ctx.userConfirmed === true);
  const needsConfirmation = level === "high" ? true : level === "medium" && reasons.length > 1;

  const labels: Record<RiskLevel, string> = {
    high: "High-risk action · requires approval",
    medium: "Staged action · reviewing",
    low: "Safe to proceed",
  };

  return { level, needsConfirmation, allow, reasons, label: labels[level] };
}

export function riskLabel(level: RiskLevel): string {
  switch (level) {
    case "high":
      return "High-risk · requires approval";
    case "medium":
      return "Medium-risk · advisory";
    default:
      return "Low-risk";
  }
}