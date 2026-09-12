import {
  Activity,
  Bot,
  Check,
  CircleDot,
  Eye,
  Pause,
  ScanLine,
  ShieldAlert,
  User,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { AgentStateKey } from "@/shared/types";

/* ------------------------------------------------------------------ *
 * StatusBadge — one authoritative status pill for every agent state.
 * Tone drives color; the icon drives recognition; the label is the
 * exact state name the rest of the panel uses. No state invented here.
 * ------------------------------------------------------------------ */

export type StatusTone = "idle" | "cyan" | "amber" | "violet" | "green" | "red";

const META: Record<AgentStateKey, { label: string; tone: StatusTone; icon: LucideIcon; pulse?: boolean }> = {
  IDLE: { label: "IDLE", tone: "idle", icon: CircleDot },
  OBSERVING: { icon: ScanLine, label: "OBSERVING", tone: "cyan" },
  THINKING: { icon: Bot, label: "REASONING", tone: "amber" },
  ACTING: { icon: Activity, label: "EXECUTING", tone: "cyan", pulse: true },
  SUCCESS: { icon: Check, label: "COMPLETED", tone: "green" },
  WAITING: { icon: User, label: "WAITING", tone: "amber" },
  PAUSED: { icon: Pause, label: "PAUSED", tone: "amber" },
  ERROR: { icon: ShieldAlert, label: "ERROR", tone: "red" },
  AWAITING_VERIFY: { icon: Eye, label: "AWAITING VERIFY", tone: "violet" },
  VERIFIED: { icon: Check, label: "VERIFIED", tone: "green" },
  VERIFY_FAILED: { icon: X, label: "NOT VERIFIED", tone: "red" },
};

export function statusMeta(status: AgentStateKey) {
  return META[status] ?? META.IDLE;
}

export function StatusBadge({ status, pulse }: { status: AgentStateKey; pulse?: boolean }) {
  const meta = statusMeta(status);
  const Icon = meta.icon;
  const animate = pulse ?? meta.pulse ?? false;
  return (
    <span className={`status-badge is-${meta.tone}`} data-status={status}>
      <span className={`status-badge__dot${animate ? " is-pulse" : ""}`} aria-hidden="true" />
      <Icon size={12} aria-hidden="true" />
      <span className="status-badge__label">{meta.label}</span>
    </span>
  );
}
