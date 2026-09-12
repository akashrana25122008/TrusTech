import { Fingerprint, Globe, ShieldCheck } from "lucide-react";
import { StatusBadge } from "./StatusBadge";
import type { AgentState } from "@/shared/types";

/* ------------------------------------------------------------------ *
 * StatusSummary — "what is the agent doing right now": status badge,
 * step counter + progress, current action line, and compact context
 * chips (site, privacy, reasoning source, trust). Everything derives
 * from live AgentState; nothing is fabricated.
 * ------------------------------------------------------------------ */

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

export function StatusSummary({ state }: { state: AgentState }) {
  const { telemetry } = state;
  const done = state.steps.filter((s) => s.status === "done").length;
  const total = state.steps.length || telemetry.totalSteps || 0;
  const active = state.steps.find((s) => s.status === "active");
  const progress = total > 0 ? Math.min(1, done / total) : 0;
  const trust = telemetry.trust;
  const reasoning = state.plan?.source === "groq" ? "GROQ" : "LOCAL FALLBACK";
  const privacyTone = telemetry.privacy === "SAFE" ? "is-green" : telemetry.privacy === "SCANNING" ? "is-amber" : "is-red";

  return (
    <section className="pd-summary" aria-label="Agent status summary">
      <div className="pd-summary__top">
        <StatusBadge status={state.status} />
        {total > 0 && (
          <span className="pd-steps" aria-label={`Step ${done} of ${total}`}>
            STEP {pad(done)} / {pad(total)}
          </span>
        )}
      </div>
      <div
        className="pd-progress"
        role="progressbar"
        aria-valuenow={Math.round(progress * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Task progress"
      >
        <span className="pd-progress__fill" style={{ width: `${Math.round(progress * 100)}%` }} />
      </div>
      {(state.task || state.actionText) && (
        <div className="pd-current">
          {state.task && (
            <p className="pd-current__task" title={state.task}>
              {state.task}
            </p>
          )}
          {active ? (
            <p className="pd-current__step">
              <span className="pd-current__k">Now</span>
              <span className="pd-current__v">{active.text}</span>
            </p>
          ) : null}
          <p className="pd-current__action" title={state.actionText}>
            {state.actionText}
          </p>
        </div>
      )}
      <div className="pd-chips">
        <span className="pd-chip" title={telemetry.currentUrl || telemetry.currentTab}>
          <Globe size={11} aria-hidden="true" />
          <span className="pd-chip__v">{telemetry.currentTab || "Your page"}</span>
        </span>
        <span className={`pd-chip ${privacyTone}`} title={typeof telemetry.redacted === "number" && telemetry.redacted > 0 ? `${telemetry.redacted} fields redacted` : "Privacy firewall status"}>
          <ShieldCheck size={11} aria-hidden="true" />
          <span className="pd-chip__v">
            PRIVACY {telemetry.privacy}
            {typeof telemetry.redacted === "number" && telemetry.redacted > 0 ? ` · ${telemetry.redacted}` : ""}
          </span>
        </span>
        <span className="pd-chip" title={state.plan?.fallbackReason ?? `Plan source: ${reasoning}`}>
          <span className="pd-chip__v">REASONING · {reasoning}</span>
        </span>
        {trust && (
          <span className="pd-chip" title={`Environment trust ${trust.score}/100`}>
            <Fingerprint size={11} aria-hidden="true" />
            <span className="pd-chip__v">
              TRUST {trust.level} {trust.score}
            </span>
          </span>
        )}
      </div>
    </section>
  );
}
