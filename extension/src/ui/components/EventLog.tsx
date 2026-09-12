import { useState } from "react";
import { ChevronDown, Terminal, Trash2 } from "lucide-react";
import type { AgentLogEntry } from "@/shared/types";

/* ------------------------------------------------------------------ *
 * EventLog — compact diagnostic console. Structured rows (time, kind
 * badge, message, truncated ids with full-value tooltips), independently
 * collapsible, capped height with its own scroll so raw diagnostics never
 * dominate the dashboard.
 * ------------------------------------------------------------------ */

const KIND_LABEL: Record<string, string> = {
  "task-start": "TASK",
  "action-start": "ACTION",
  "action-ok": "OK",
  "action-fail": "FAIL",
  "verify-ok": "VERIFY",
  "verify-fail": "VERIFY",
  recovery: "RETRY",
  paused: "PAUSED",
  "task-done": "DONE",
  verified: "VERDICT",
};

function shortId(id: string | undefined): string | null {
  if (!id) return null;
  return id.length > 16 ? `${id.slice(0, 14)}…` : id;
}

function RowIds({ entry }: { entry: AgentLogEntry }) {
  const e = entry.event;
  if (!e) return null;
  const ids = [e.taskId, e.actionId, e.stepId].filter(Boolean) as string[];
  if (ids.length === 0) return null;
  return (
    <span className="pd-log__ids">
      {ids.map((id) => (
        <span key={id} className="timeline__id" title={id}>
          {shortId(id)}
        </span>
      ))}
    </span>
  );
}

export function EventLog({
  log,
  status,
  onClear,
}: {
  log: AgentLogEntry[];
  status: string;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rows = log.slice(-40);
  return (
    <section className="pd-log" aria-label="Event log">
      <div className="pd-log__head">
        <button
          type="button"
          className="pd-log__toggle"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <Terminal size={12} aria-hidden="true" />
          <span>Event log</span>
          <span className="pd-live">
            <span className="pd-live__dot" aria-hidden="true" />
            LIVE
          </span>
          <ChevronDown size={12} aria-hidden="true" className={`pd-log__chevron${open ? " is-open" : ""}`} />
        </button>
        <span className={`pd-log__status pd-log__status--${status}`} aria-label={`Agent status ${status}`}>
          {status}
        </span>
        <button type="button" className="pd-log__clear" onClick={onClear} disabled={log.length === 0} aria-label="Clear event log">
          <Trash2 size={12} aria-hidden="true" />
        </button>
      </div>
      {open && (
        <div className="pd-log__body" role="log" aria-label="Agent event log entries">
          {rows.length === 0 ? (
            <p className="timeline-empty">No activity yet. Agents emit events here as they run.</p>
          ) : (
            rows.map((entry) => (
              <div key={entry.id} className={`pd-log__line pd-log__line--${entry.level}`}>
                <span className="pd-log__time">
                  {new Date(entry.at).toLocaleTimeString([], { hour12: false })}
                </span>
                {entry.event && (
                  <span className="pd-log__kind" title={entry.event.kind}>
                    {KIND_LABEL[entry.event.kind] ?? "LOG"}
                  </span>
                )}
                <span className="pd-log__text" title={entry.text}>
                  {entry.text}
                </span>
                <RowIds entry={entry} />
              </div>
            ))
          )}
        </div>
      )}
    </section>
  );
}
