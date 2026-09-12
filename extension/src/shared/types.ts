/* ------------------------------------------------------------------ *
 * TrusTech — shared domain types
 * ------------------------------------------------------------------ */

export type AgentStateKey =
  | "IDLE"
  | "OBSERVING"
  | "THINKING"
  | "ACTING"
  | "SUCCESS"
  | "WAITING"
  | "PAUSED"
  | "ERROR";

export type StepStatus =
  | "pending"
  | "active"
  | "done"
  | "blocked"
  | "failed"
  | "skipped"
  | "replaced";

export interface TaskStep {
  id: string;
  text: string;
  status: StepStatus;
  /** Why a step left the happy path (blocked/failed/replaced/skipped). */
  statusReason?: string;
}

/** Provenance of the plan behind the Action Timeline. */
export interface PlanMeta {
  /** groq = real semantic plan from the reasoning provider; local = task-sourced fallback. */
  source: "groq" | "local";
  /** Only set when the reasoning provider path failed and a fallback plan was used. */
  fallbackReason?: string;
}

/**
 * Structured task data, split by provenance so user-provided and model
 * generated values are never conflated.
 */
export interface TaskData {
  /** Concrete values the user gave in the goal ("fill my name Arjun Singh"). */
  inputs?: Record<string, string>;
  /** Harmless synthetic values for sample/dummy/test requests (secret-scrubbed). */
  generated?: Record<string, string>;
  /** One-line task interpretation — concise summary, never chain-of-thought. */
  interpretation?: string;
}

export type RiskLevel = "low" | "medium" | "high";

export interface RiskGateInfo {
  label: string;
  reasons: string[];
  level: RiskLevel;
  /** Canonical action instance awaiting approval (bound confirmation). */
  actionId?: string;
  /** Value-free label: action name + target label. */
  actionLabel?: string;
  riskLevel?: string;
  confidence?: number;
}

export interface Telemetry {
  /** 0 - 100 */
  confidence: number;
  /** 0 - 100 */
  vision: number;
  privacy: "SAFE" | "SCANNING" | "ALERT";
  browserControl: boolean;
  step: number;
  totalSteps: number;
  currentTab: string;
  currentUrl: string;
  /** PII fields blocked by the privacy firewall on the last outbound scan. */
  redacted?: number;
  /** Latest Feature #6 environment trust (score + level only). */
  trust?: { score: number; level: "VERY_HIGH" | "HIGH" | "CAUTION" | "LOW" | "CRITICAL" };
}

export interface AgentState {
  status: AgentStateKey;
  task: string;
  steps: TaskStep[];
  actionText: string;
  telemetry: Telemetry;
  /** Populated while the agent waits on a risk/consent gate. */
  risk?: RiskGateInfo | null;
  /** Ordered debug/event console feed for the panel. */
  log: AgentLogEntry[];
  /** Provenance of the current plan (groq vs local fallback). */
  plan?: PlanMeta | null;
  /** Structured task data (user-provided vs generated sample data + interpretation). */
  data?: TaskData | null;
}

export interface AgentLogEntry {
  id: string;
  at: number;
  level: "info" | "action" | "risk" | "success" | "error";
  text: string;
}

export const INITIAL_TELEMETRY: Telemetry = {
  confidence: 98,
  vision: 92,
  privacy: "SAFE",
  browserControl: false,
  step: 0,
  totalSteps: 6,
  currentTab: "Your page",
  currentUrl: "",
};

export const INITIAL_STATE: AgentState = {
  status: "IDLE",
  task: "",
  steps: [],
  actionText: "Standing by. Describe a task to take control of the browser.",
  telemetry: INITIAL_TELEMETRY,
  log: [],
  plan: null,
  data: null,
};

/* ------------------------------------------------------------------ *
 * Extension messaging protocol (panel <-> background <-> page)
 * ------------------------------------------------------------------ */

export type HighlightKind = "click" | "type" | "scroll" | "navigate" | "clear";

export interface AgentHighlightMessage {
  type: "AGENT_HIGHLIGHT";
  payload: {
    kind: HighlightKind;
    label: string;
    selector?: string;
  };
}

export interface AgentBeamMessage {
  type: "AGENT_BEAM";
  payload: { on: boolean; selector?: string };
}

export type InjectActionCommand =
  | "click"
  | "type"
  | "scroll"
  | "select"
  | "newTab"
  | "closeTab"
  | "back"
  | "forward"
  | "reload";

export interface AgentInjectMessage {
  type: "AGENT_INJECT_ACTION";
  payload: { command: InjectActionCommand; selector?: string; value?: string };
}

export interface BrowserCommandMessage {
  type: "BROWSER_COMMAND";
  payload: { command: InjectActionCommand; selector?: string; value?: string };
}

export interface AgentStateMessage {
  type: "AGENT_STATE";
  payload: { status: AgentStateKey; actionText: string };
}

export type ExtensionMessage =
  | AgentHighlightMessage
  | AgentBeamMessage
  | AgentInjectMessage
  | BrowserCommandMessage
  | AgentStateMessage;