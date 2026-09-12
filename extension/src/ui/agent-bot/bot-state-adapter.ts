/* ------------------------------------------------------------------ *
 * Browser-agent → bot state adapter. Decouples the 3D companion from
 * the agent's internal state manager: swap the mapping here and the bot
 * reacts differently without any change to itself or the agent.
 * ------------------------------------------------------------------ */

import type { AgentStateKey } from "@/shared/types";
import type { BotState } from "./types";

const AGENT_TO_BOT: Record<AgentStateKey, BotState> = {
  IDLE: "idle",
  OBSERVING: "observing",
  THINKING: "thinking",
  ACTING: "acting",
  WAITING: "waiting",
  SUCCESS: "success",
  PAUSED: "paused",
  ERROR: "error",
  // Verification states reuse companion moods: awaiting input waits,
  // a confirmed objective celebrates, a rejected one settles.
  AWAITING_VERIFY: "waiting",
  VERIFIED: "success",
  VERIFY_FAILED: "idle",
};

/** Map an agent runtime/UI state to the 3D bot's visual state. */
export function mapAgentToBot(agent: AgentStateKey): BotState {
  return AGENT_TO_BOT[agent] ?? "idle";
}