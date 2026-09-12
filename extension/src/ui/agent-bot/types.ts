/* ------------------------------------------------------------------ *
 * Bot state — a clean, agent-agnostic vocabulary for the 3D companion.
 * The browser agent's internal state is mapped onto these via
 * bot-state-adapter.ts; the bot component never touches agent internals.
 * ------------------------------------------------------------------ */

export type BotState =
  | "idle"
  | "observing"
  | "thinking"
  | "acting"
  | "waiting"
  | "success"
  | "paused"
  | "error";