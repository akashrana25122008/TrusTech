import type { AgentLogEntry, AgentStateKey } from "@/shared/types";
import { Terminal } from "lucide-react";

const LEVEL_CLASS: Record<AgentLogEntry["level"], string> = {
  info: "debug-console__line--info",
  action: "debug-console__line--action",
  risk: "debug-console__line--risk",
  success: "debug-console__line--success",
  error: "debug-console__line--error",
};

const STATUS_LABEL: Record<AgentStateKey, string> = {
  IDLE: "idle",
  OBSERVING: "observing",
  THINKING: "thinking",
  ACTING: "acting",
  SUCCESS: "complete",
  WAITING: "waiting",
  PAUSED: "paused",
  ERROR: "error",
};

export function DebugConsole({
  status,
  log,
  onClear,
}: {
  status: AgentStateKey;
  log: AgentLogEntry[];
  onClear: () => void;
}) {
  const time = (at: number) =>
    new Date(at).toLocaleTimeString([], { hour12: false });

  return (
    <section className="debug-console">
      <div className="debug-console__head">
        <span className="debug-console__title">
          <Terminal size={12} aria-hidden="true" />
          <span>Event log</span>
          <span className={`debug-console__status debug-console__status--${STATUS_LABEL[status]}`}>
            {STATUS_LABEL[status]}
          </span>
        </span>
        <button className="debug-console__clear" onClick={onClear} disabled={log.length === 0}>
          Clear
        </button>
      </div>
      <div className="debug-console__body">
        {log.length === 0 ? (
          <p className="debug-console__empty">No activity yet. Agents emit events here as they run.</p>
        ) : (
          log.map((entry) => (
            <div key={entry.id} className={`debug-console__line ${LEVEL_CLASS[entry.level]}`}>
              <span className="debug-console__time">{time(entry.at)}</span>
              <span className="debug-console__text">{entry.text}</span>
            </div>
          ))
        )}
      </div>
    </section>
  );
}