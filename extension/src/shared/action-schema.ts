/* ------------------------------------------------------------------ *
 * Action protocol — the ONLY way the agent may control the browser.
 *
 * The LLM/reasoning layer communicates exclusively through these typed
 * actions. Every action passes: JSON parse → schema validation → target
 * validation → risk validation → execution. Free-form output is never
 * executed.
 *
 * SEARCH is a semantic composite, not a text-entry instruction: it
 * resolves a search input, enters the query, submits (Enter, then search-
 * button fallback), and verifies result state. Typing a query is only the
 * input stage — SEARCH succeeds solely on verified results.
 * ------------------------------------------------------------------ */

export type ActionName =
  | "navigate"
  | "new_tab"
  | "close_tab"
  | "switch_tab"
  | "back"
  | "forward"
  | "reload"
  | "click"
  | "double_click"
  | "type"
  | "search"
  | "clear"
  | "select"
  | "check"
  | "uncheck"
  | "radio"
  | "scroll"
  | "hover"
  | "focus"
  | "press_key"
  | "wait"
  | "extract"
  | "submit"
  | "finish"
  | "ask_user";

export const ALL_ACTION_NAMES: readonly ActionName[] = [
  "navigate", "new_tab", "close_tab", "switch_tab", "back", "forward", "reload",
  "click", "double_click", "type", "search", "clear", "select", "check", "uncheck",
  "radio", "scroll", "hover", "focus", "press_key", "wait", "extract",
  "submit", "finish", "ask_user",
];

/**
 * Target identity. Priority at grounding time:
 * elementId → role+name → semantic attrs → visible text → stable selector.
 * Coordinates are a last-resort and never the primary mechanism.
 */
export interface TargetSpec {
  /** Temporary agent id from the latest observation (el_001…). */
  elementId?: string;
  /** Accessibility role. */
  role?: string;
  /** Accessible name / label / visible text. */
  name?: string;
  /** Stable selector — used only when ids/names fail and rules allow it. */
  selector?: string;
}

export type ExpectedOutcomeType =
  | "url_change"
  | "navigation"
  | "content_change"
  | "element_state"
  | "tab_switch"
  | "noop";

export interface ExpectedOutcome {
  type?: ExpectedOutcomeType;
  urlContains?: string;
  elementState?: {
    textContains?: string;
    visible?: boolean;
    enabled?: boolean;
    selected?: boolean;
    checked?: boolean;
  };
}

export interface AgentAction {
  action: ActionName;
  /** 0..1, advisory — never a substitute for validation. */
  confidence?: number;
  target?: TargetSpec;
  /** navigate / new_tab. */
  url?: string;
  /** type / search-query / extract-label. */
  text?: string;
  /** select option (text or value). */
  option?: string;
  /** press_key — e.g. Enter / Escape. */
  key?: string;
  /** ask_user / finish messaging. */
  reason?: string;
  result?: string;
  /** wait duration in ms. */
  ms?: number;
  expectedOutcome?: ExpectedOutcome;
}

/**
 * Action names that require a page-level target. "search" is deliberately
 * absent: its query is required but its input is optional — the executor
 * self-resolves a search field (and fails honestly when none exists).
 */
const PAGE_TARGET_ACTIONS: ReadonlySet<ActionName> = new Set([
  "click", "double_click", "type", "clear", "select", "check", "uncheck",
  "radio", "scroll", "hover", "focus", "submit",
]);

/** Fields required per action kind. */
const REQUIRED: Partial<Record<ActionName, (a: AgentAction) => boolean>> = {
  navigate: (a) => typeof a.url === "string" && a.url.length > 0,
  type: (a) => typeof a.text === "string",
  // SEARCH always carries its query; the target (search input) is
  // optional because the executor self-resolves a search field when the
  // planner omits one. A missing query is a planning defect, never
  // something the executor may invent.
  search: (a) => typeof a.text === "string" && a.text.length > 0,
  select: (a) => typeof a.option === "string",
  press_key: (a) => typeof a.key === "string",
  wait: (a) => typeof a.ms === "number" && a.ms > 0,
};

export interface ActionValidation {
  ok: boolean;
  action?: AgentAction;
  errors: string[];
  filtered?: ActionName;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Validate raw (possibly model-produced) JSON into a safe AgentAction.
 * `allowed` restricts the acceptable action set for the current task.
 */
export function validateAction(input: unknown, allowed: readonly ActionName[] = ALL_ACTION_NAMES): ActionValidation {
  const errors: string[] = [];
  if (!isPlainObject(input)) return { ok: false, errors: ["action must be a JSON object"] };

  const rawName = input.action;
  if (typeof rawName !== "string" || !(ALL_ACTION_NAMES as readonly string[]).includes(rawName)) {
    return { ok: false, errors: [`unknown action: ${String(rawName)}`] };
  }
  const name = rawName as ActionName;
  if (!allowed.includes(name)) {
    return { ok: false, errors: [`action "${name}" is not allowed for this task`], filtered: name };
  }

  const action: AgentAction = { action: name };

  if (input.confidence !== undefined) {
    const conf = Number(input.confidence);
    if (Number.isFinite(conf)) action.confidence = Math.max(0, Math.min(1, conf));
  }
  if (input.url !== undefined && typeof input.url === "string") action.url = input.url;
  if (input.text !== undefined && typeof input.text === "string") action.text = input.text;
  if (input.option !== undefined && typeof input.option === "string") action.option = input.option;
  if (input.key !== undefined && typeof input.key === "string") action.key = input.key;
  if (input.reason !== undefined && typeof input.reason === "string") action.reason = input.reason;
  if (input.result !== undefined && typeof input.result === "string") action.result = input.result;
  if (input.ms !== undefined && typeof input.ms === "number") action.ms = input.ms;

  if (isPlainObject(input.target)) {
    const t = input.target;
    const target: TargetSpec = {};
    if (typeof t.elementId === "string") target.elementId = t.elementId;
    if (typeof t.role === "string") target.role = t.role;
    if (typeof t.name === "string") target.name = t.name;
    if (typeof t.selector === "string") target.selector = t.selector;
    if (target.elementId || target.role || target.name || target.selector) action.target = target;
  }

  if (isPlainObject(input.expectedOutcome)) {
    const eo = input.expectedOutcome as Record<string, unknown>;
    action.expectedOutcome = {
      type: typeof eo.type === "string" ? (eo.type as ExpectedOutcomeType) : undefined,
      urlContains: typeof eo.urlContains === "string" ? eo.urlContains : undefined,
      elementState:
        isPlainObject(eo.elementState) && (eo.elementState as Record<string, unknown>).textContains !== undefined
          ? { textContains: (eo.elementState as Record<string, unknown>).textContains as string }
          : undefined,
    };
  }

  if (PAGE_TARGET_ACTIONS.has(name) && !action.target) {
    errors.push(`action "${name}" requires a target`);
  }
  if (REQUIRED[name] && !REQUIRED[name]!(action)) {
    errors.push(`action "${name}" is missing required fields`);
  }

  return errors.length === 0 ? { ok: true, action, errors: [] } : { ok: false, errors };
}