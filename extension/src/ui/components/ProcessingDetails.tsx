import { ChevronDown, ListTree } from "lucide-react";
import { StatusSummary } from "./StatusSummary";
import { TaskPlan } from "./TaskPlan";
import { ExecutionTimeline } from "./ExecutionTimeline";
import { VerificationPanel } from "./VerificationPanel";
import { EventLog } from "./EventLog";
import { finalStateSummary } from "./statusText";
import type { AgentState } from "@/shared/types";

/* ------------------------------------------------------------------ *
 * ProcessingDetails — the agent execution dashboard. Collapsed it is a
 * single compact row; expanded it layers STATUS SUMMARY → TASK PLAN →
 * EXECUTION TIMELINE → VERIFICATION → EVENT LOG over the SAME live
 * AgentState every other surface reads. Nothing here is simulated and
 * no step is ever marked done by this layer — the controller owns all
 * truth via PLAN_CHANGED and the event bus.
 * ------------------------------------------------------------------ */

export function ProcessingDetails({
  state,
  onClearLog,
  open,
  onToggle,
}: {
  state: AgentState;
  onClearLog: () => void;
  open: boolean;
  onToggle: (open: boolean) => void;
}) {
  const final = finalStateSummary(state.status, state.actionText);
  const inputEntries = state.data?.inputs ? Object.entries(state.data.inputs) : [];
  const generatedEntries = state.data?.generated ? Object.entries(state.data.generated) : [];

  const dataRow = (k: string, v: string) => (
    <div key={k} className="processing__data-row">
      <span className="processing__data-key">{k}</span>
      <span className="processing__data-value">{v}</span>
    </div>
  );

  return (
    <section className={`processing ${open ? "is-open" : ""}`} data-open={open}>
      <button
        type="button"
        className="processing__toggle"
        aria-expanded={open}
        aria-controls="processing-details"
        onClick={() => onToggle(!open)}
      >
        <ListTree size={14} aria-hidden="true" />
        <span>{open ? "Hide processing details" : "View processing details"}</span>
        <span className="processing__status-dot" data-status={state.status} aria-hidden="true" />
        <ChevronDown size={14} aria-hidden="true" className="processing__chevron" />
      </button>

      {open && (
      <div id="processing-details" className="processing__body" role="region" aria-label="Processing details">
        <div className="processing__body-inner">
        <StatusSummary state={state} />

        {final && (
          <div className="processing__final" data-state={state.status}>
            {state.status === "ERROR" && <div className="block-eyebrow">FAILURE / STOP REASON</div>}
            {state.status === "PAUSED" && <div className="block-eyebrow">PAUSED — REASON</div>}
            {state.status === "AWAITING_VERIFY" && <div className="block-eyebrow">EXECUTION COMPLETE — VERIFY THE RESULT YOURSELF</div>}
            {state.status === "VERIFY_FAILED" && <div className="block-eyebrow">OBJECTIVE NOT MET</div>}
            <span className="processing__final-label">{final.label}</span>
            <span className="processing__final-detail">{final.detail}</span>
          </div>
        )}

        {(state.data?.interpretation || inputEntries.length > 0 || generatedEntries.length > 0) && (
          <div className="processing__taskdata">
            {state.data?.interpretation && (
              <div className="processing__feed">
                <div className="block-eyebrow">TASK INTERPRETATION</div>
                <div className="processing__interpretation">{state.data.interpretation}</div>
              </div>
            )}
            {inputEntries.length > 0 && (
              <div className="processing__feed">
                <div className="block-eyebrow">FROM YOUR TASK</div>
                {inputEntries.map(([k, v]) => dataRow(k, v))}
              </div>
            )}
            {generatedEntries.length > 0 && (
              <div className="processing__feed">
                <div className="block-eyebrow">GENERATED SAMPLE DATA</div>
                <div className="processing__data-note">Synthetic values — never real credentials or secrets.</div>
                {generatedEntries.map(([k, v]) => dataRow(k, v))}
              </div>
            )}
          </div>
        )}

        <TaskPlan steps={state.steps} meta={state.plan} />

        <ExecutionTimeline log={state.log} />

        <VerificationPanel state={state} />

        <EventLog log={state.log} status={state.status} onClear={onClearLog} />
        </div>
      </div>
      )}
    </section>
  );
}
