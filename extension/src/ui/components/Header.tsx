import { Waves } from "lucide-react";
import type { AgentStateKey } from "@/shared/types";

export const STATUS_LABEL: Record<AgentStateKey, string> = {
  IDLE: "ONLINE",
  OBSERVING: "OBSERVING",
  THINKING: "THINKING",
  ACTING: "ACTING",
  SUCCESS: "COMPLETED",
  WAITING: "WAITING",
  PAUSED: "PAUSED",
  ERROR: "ERROR",
};

/* Minimal identity bar: brand + live status. Nothing else competes with
   the bot hero below. */
export function Header({ status }: { status: AgentStateKey }) {
  return (
    <header className="topbar topbar--minimal">
      <div className="brand">
        <div className="orb" aria-hidden="true">
          <Waves size={15} strokeWidth={2.2} />
          <span className="orb-ring" />
        </div>
        <div className="brand-text">
          <div className="brand-name">TRusTech</div>
        </div>
      </div>

      <div className="topbar-right">
        <span className="status-pill is-online" data-status={status} role="status">
          <span className="dot" aria-hidden="true" />
          {STATUS_LABEL[status] ?? "ONLINE"}
        </span>
      </div>
    </header>
  );
}