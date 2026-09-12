import { Ban, Check, Circle, Loader2, Minus, RotateCw, X } from "lucide-react";
import type { CSSProperties } from "react";
import type { PlanMeta, TaskStep } from "@/shared/types";

/* ------------------------------------------------------------------ *
 * TaskPlan — the controller-owned task plan rendered as a visual step
 * list: number, state icon, description, status reason, and truncated
 * action id. Step truth comes from the PLAN_CHANGED writer only; this
 * component never invents completion.
 * ------------------------------------------------------------------ */

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
    case "pending":
      return <Circle size={9} />;
    default:
      return <Circle size={9} />;
  }
}

function shortId(id: string): string {
  return id.length > 14 ? `${id.slice(0, 12)}…` : id;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

export function TaskPlan({ steps, meta }: { steps: TaskStep[]; meta?: PlanMeta | null }) {
  if (steps.length === 0) {
    return (
      <section className="timeline-block" aria-label="Task plan">
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
    <section className="timeline-block" aria-label="Task plan">
      <div className="block-eyebrow">
        <span>TASK PLAN</span>
        <span className={`plan-source plan-source--${meta?.source ?? "local"}`}>
          {meta?.source === "groq" ? "Reasoning · Groq" : "Plan · Local fallback"}
        </span>
      </div>
      <ol className="timeline">
        {steps.map((step, i) => (
          <li
            key={step.id}
            className={`timeline__item is-${step.status}`}
            style={{ "--i": i } as CSSProperties}
            title={step.statusReason ?? `${step.id} · ${step.status}`}
          >
            <span className="timeline__marker">{marker(step.status)}</span>
            <span className="timeline__num" aria-hidden="true">
              {pad(i + 1)}
            </span>
            <span className="timeline__body">
              <span className="timeline__text">{step.text}</span>
              <span className="timeline__meta">
                <span className="timeline__id" title={step.id}>
                  {shortId(step.id)}
                </span>
                {step.status === "active" && <span className="timeline__now" aria-hidden="true" />}
                {step.statusReason && <span className="timeline__reason">{step.statusReason}</span>}
              </span>
            </span>
          </li>
        ))}
      </ol>
      {meta?.fallbackReason && <div className="timeline-fallback">fallback: {meta.fallbackReason}</div>}
    </section>
  );
}
