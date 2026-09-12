import { AlertTriangle, Check, Loader2, RotateCw, XCircle } from "lucide-react";
import type { AgentLogEntry } from "@/shared/types";

/* ------------------------------------------------------------------ *
 * ExecutionTimeline — one structured row per executed browser action,
 * grouped by canonical action id: start → terminal outcome (verified /
 * failed + evidence). Built ONLY from structured log events (kind +
 * ids); text-only entries never fabricate timeline rows. Retries of the
 * same action id collapse into one row with an attempt count.
 * ------------------------------------------------------------------ */

interface ActionRow {
  key: string;
  spec: string;
  actionId?: string;
  stepId?: string;
  status: "running" | "ok" | "failed";
  detail?: string;
  attempts: number;
  at: number;
}

function shortId(id: string | undefined): string | null {
  if (!id) return null;
  return id.length > 14 ? `${id.slice(0, 12)}…` : id;
}

function buildRows(log: AgentLogEntry[]): ActionRow[] {
  const rows = new Map<string, ActionRow>();
  const order: string[] = [];
  const ensure = (key: string, fallback: Partial<ActionRow>): ActionRow => {
    let row = rows.get(key);
    if (!row) {
      row = {
        key,
        spec: fallback.spec ?? "action",
        actionId: fallback.actionId,
        stepId: fallback.stepId,
        status: "running",
        attempts: 0,
        at: fallback.at ?? Date.now(),
      };
      rows.set(key, row);
      order.push(key);
    }
    return row;
  };
  for (const entry of log) {
    const e = entry.event;
    if (!e) continue;
    if (e.kind === "action-start" && e.actionId) {
      const row = ensure(e.actionId, { spec: e.spec, actionId: e.actionId, stepId: e.stepId, at: entry.at });
      if (e.spec) row.spec = e.spec;
      if (e.stepId) row.stepId = e.stepId;
      row.status = "running";
      row.attempts += 1;
      row.at = entry.at;
    } else if ((e.kind === "action-ok" || e.kind === "verify-ok") && e.actionId) {
      const row = ensure(e.actionId, { spec: e.spec, actionId: e.actionId, stepId: e.stepId, at: entry.at });
      row.status = "ok";
      row.at = entry.at;
    } else if ((e.kind === "action-fail" || e.kind === "verify-fail") && e.actionId) {
      const row = ensure(e.actionId, { spec: e.spec, actionId: e.actionId, stepId: e.stepId, at: entry.at });
      row.status = "failed";
      // Retried actions re-enter through action-start, so attempts accumulate
      // there; the terminal outcome here only flips status + reason.
      row.detail = e.error ?? (e.evidence ?? []).join("; ").slice(0, 160) ?? e.details;
      row.at = entry.at;
    }
  }
  return order.map((k) => rows.get(k)!).slice(-12);
}

function RowIcon({ status }: { status: ActionRow["status"] }) {
  if (status === "ok") return <Check size={11} aria-hidden="true" />;
  if (status === "failed") return <XCircle size={11} aria-hidden="true" />;
  return <Loader2 size={11} aria-hidden="true" className="spin" />;
}

export function ExecutionTimeline({ log }: { log: AgentLogEntry[] }) {
  const rows = buildRows(log);
  const retryNote = log.some((e) => e.event?.kind === "recovery");
  if (rows.length === 0) {
    return (
      <section className="timeline-block" aria-label="Execution timeline">
        <div className="block-eyebrow">EXECUTION</div>
        <div className="timeline-empty">No page actions yet.</div>
      </section>
    );
  }
  return (
    <section className="timeline-block" aria-label="Execution timeline">
      <div className="block-eyebrow">
        <span>EXECUTION</span>
        {retryNote && (
          <span className="pd-retry-note" title="Some actions needed retries — see event log">
            <RotateCw size={10} aria-hidden="true" /> retries
          </span>
        )}
      </div>
      <ol className="exec-timeline">
        {rows.map((row) => {
          const id = shortId(row.actionId);
          return (
            <li key={row.key} className={`exec-timeline__item is-${row.status}`}>
              <span className="exec-timeline__marker">
                <RowIcon status={row.status} />
              </span>
              <span className="exec-timeline__body">
                <span className="exec-timeline__action" title={row.spec}>
                  {row.spec}
                </span>
                <span className="exec-timeline__meta">
                  {id && (
                    <span className="timeline__id" title={row.actionId}>
                      {id}
                    </span>
                  )}
                  {row.attempts > 1 && <span className="pd-attempts">×{row.attempts}</span>}
                  {row.detail && (
                    <span className="timeline__reason" title={row.detail}>
                      <AlertTriangle size={9} aria-hidden="true" /> {row.detail}
                    </span>
                  )}
                </span>
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
