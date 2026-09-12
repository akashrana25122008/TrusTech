import { Check, CircleDot, ScanLine, Bomb, Timer, User, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { AgentStateKey } from "@/shared/types";

/* Compact telemetry row showing the agent's current state with an
   inline animated energy fill. */

const META: Record<AgentStateKey, { icon: LucideIcon; label: string }> = {
  IDLE: { icon: CircleDot, label: "Ready" },
  OBSERVING: { icon: ScanLine, label: "Observing page" },
  THINKING: { icon: Timer, label: "Planning" },
  ACTING: { icon: Timer, label: "Executing" },
  SUCCESS: { icon: Check, label: "Task completed" },
  WAITING: { icon: User, label: "Awaiting you" },
  PAUSED: { icon: Timer, label: "Paused" },
  ERROR: { icon: Bomb, label: "Blocked" },
  AWAITING_VERIFY: { icon: User, label: "Verify the result" },
  VERIFIED: { icon: Check, label: "Objective verified" },
  VERIFY_FAILED: { icon: X, label: "Objective not met" },
};

export function StateIndicator({ status }: { status: AgentStateKey }) {
  const meta = META[status];
  const Icon = meta.icon;
  return (
    <div className="state-bar" data-status={status}>
      <div className="state-bar__icon">
        <Icon size={13} />
      </div>
      <span className="state-bar__label">{meta.label}</span>
      <span className="state-bar__energy" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
        <i />
      </span>
    </div>
  );
}