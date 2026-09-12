import { ChevronDown, ListTree } from "lucide-react";
import { ActionTimeline } from "./ActionTimeline";
import { DebugConsole } from "./DebugConsole";
import { finalStateSummary } from "./statusText";
import type { AgentLogEntry, AgentState } from "@/shared/types";

/* ------------------------------------------------------------------ *
 * ProcessingDetails — the single collapsed-by-default drawer for all
 * technical agent processing. Every row is real runtime state:
 * steps + event log come straight from useAgentState; nothing here is
 * simulated. On wide panels the region docks to the LEFT with the bot
 * hero remaining visible on the right (see globals.css).
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
  const { telemetry } = state;
  const done = state.steps.filter((s) => s.status === "done").length;
  const final = finalStateSummary(state.status, state.actionText);
  const executionEntries = state.log.filter((e) => e.level === "action" || e.level === "error" || e.level === "risk");
  const verificationEntries = state.log.filter((e) => e.level === "success");
  const inputEntries = state.data?.inputs ? Object.entries(state.data.inputs) : [];
  const generatedEntries = state.data?.generated ? Object.entries(state.data.generated) : [];

  const line = (entry: AgentLogEntry) => (
    <div key={entry.id} className="processing__feed-line">
      <span className="processing__feed-time">{new Date(entry.at).toLocaleTimeString([], { hour12: false })}</span>
      <span className="processing__feed-text">{entry.text}</span>
    </div>
  );

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
        <ChevronDown size={14} aria-hidden="true" className="processing__chevron" />
      </button>

      {open && (
      <div id="processing-details" className="processing__body" role="region" aria-label="Processing details">
        <div className="processing__body-inner">
        <div className="processing__meta">
          <span className="processing__meta-item">
            Step {done}/{state.steps.length || telemetry.totalSteps || 0}
          </span>
          <span className="processing__meta-item">
            <span className={`plan-source plan-source--${state.plan?.source ?? "local"}`}>
              Reasoning · {state.plan?.source === "groq" ? "Groq" : "Local fallback"}
            </span>
          </span>
          {state.plan?.fallbackReason && (
            <span className="processing__meta-item" title={state.plan.fallbackReason}>
              fallback: {state.plan.fallbackReason}
            </span>
          )}
          <span className="processing__meta-dot" aria-hidden="true" />
          <span className="processing__meta-item processing__meta-item--tab">
            {telemetry.currentTab || "Your page"}
          </span>
          {telemetry.currentUrl ? (
            <>
              <span className="processing__meta-dot" aria-hidden="true" />
              <span className="processing__meta-item processing__meta-item--url" title={telemetry.currentUrl}>
                {telemetry.currentUrl}
              </span>
            </>
          ) : null}
          <span className="processing__meta-dot" aria-hidden="true" />
          <span className="processing__meta-item">Privacy {telemetry.privacy}</span>
          {typeof telemetry.redacted === "number" && telemetry.redacted > 0 && (
            <span className="processing__meta-item">· {telemetry.redacted} redacted</span>
          )}
        </div>

        {final && (
          <div className="processing__final" data-state={state.status}>
            {state.status === "ERROR" && <div className="block-eyebrow">FAILURE / STOP REASON</div>}
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

        <ActionTimeline steps={state.steps} meta={state.plan} />

        <div className="processing__feed">
          <div className="block-eyebrow">EXECUTION</div>
          {executionEntries.length === 0 ? (
            <div className="timeline-empty">No page actions yet.</div>
          ) : (
            executionEntries.slice(-12).map(line)
          )}
        </div>
        <div className="processing__feed">
          <div className="block-eyebrow">VERIFICATION</div>
          {verificationEntries.length === 0 ? (
            <div className="timeline-empty">No verified outcomes yet.</div>
          ) : (
            verificationEntries.slice(-8).map(line)
          )}
        </div>

        <DebugConsole status={state.status} log={state.log.slice(-40)} onClear={onClearLog} />
        </div>
      </div>
      )}
    </section>
  );
}
