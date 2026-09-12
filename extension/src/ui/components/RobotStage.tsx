import { AgentBot, type AgentBotHandle } from "@/ui/agent-bot/AgentBot";
import { mapAgentToBot } from "@/ui/agent-bot/bot-state-adapter";
import type { AgentStateKey } from "@/shared/types";

/* ------------------------------------------------------------------ *
 * RobotStage — the hero. The bot dominates; no telemetry chips, no
 * cards around the character. Status is communicated by the task /
 * action lines below, never by overlays on the bot itself.
 * ------------------------------------------------------------------ */

export function RobotStage({
  mode,
  onChamberReady,
}: {
  mode: AgentStateKey;
  onChamberReady?: (h: AgentBotHandle) => void;
}) {
  return (
    <section className="hero" aria-label="TRusTech AI companion">
      <div className="hero-void" aria-hidden="true">
        <span className="hero-halo" />
        <span className="hero-vignette" />
      </div>

      <AgentBot state={mapAgentToBot(mode)} onReady={onChamberReady} />
    </section>
  );
}