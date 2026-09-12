import { Ban, Check, Circle, Loader2, Minus, RotateCw, X } from "lucide-react";
import type { CSSProperties } from "react";
import type { PlanMeta, TaskStep } from "@/shared/types";

function marker(status: TaskStep["status"]) {
  switch (status) {
    case "done":
      return <Check size={11} />;
    case "active":
      return <Loader2 size={11} className="spin" />;
    case "blocked":
      return <Ban size={10} />;
    case "failed":
      return <X size={10} />;
    case "skipped":
      return <Minus size={10} />;
    case "replaced":
      return <RotateCw size={10} />;
    default:
      return <Circle size={9} />;
  }
}

export function ActionTimeline({ steps, meta }: { steps: TaskStep[]; meta?: PlanMeta | null }) {
  if (steps.length === 0) {
    return (
      <section className="timeline-block">
        <div className="block-eyebrow">TASK PLAN</div>
        <div className="timeline-empty">
          {meta?.source === "groq" || !meta
            ? "The agent is reasoning — the Groq task plan will appear here."
            : "Completed actions will appear here as the agent works."}
        </div>
      </section>
    );
  }

  return (
    <section className="timeline-block">
      <div className="block-eyebrow">
        <span>TASK PLAN</span>
        <span className={`plan-source plan-source--${meta?.source ?? "local"}`}>
          {meta?.source === "groq" ? "Reasoning · Groq" : "Plan · Local fallback"}
        </span>
      </div>
      <ol className="timeline">
        {steps.map((step, i) => (
          <li key={step.id} className={`timeline__item is-${step.status}`} style={{ "--i": i } as CSSProperties} title={step.statusReason}>
            <span className="timeline__marker">{marker(step.status)}</span>
            <span className="timeline__text">{step.text}</span>
            {step.status === "active" && <span className="timeline__now" aria-hidden="true" />}
          </li>
        ))}
      </ol>
      {meta?.fallbackReason && <div className="timeline-fallback">fallback: {meta.fallbackReason}</div>}
    </section>
  );
}