import { Pause, Square, Play } from "lucide-react";
import type { AgentState } from "@/shared/types";

/* Compact running-task block: the goal, the live action line, and
   pause/stop. All metrics live inside the processing-details drawer. */
export function LiveAgentControls({
  state,
  onPause,
  onResume,
  onStop,
}: {
  state: AgentState;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
}) {
  const paused = state.status === "PAUSED";

  return (
    <section className="run-block" data-status={state.status} aria-live="polite">
      <p className="run-block__task">{state.task}</p>
      <p className="run-block__action">
        <span className="run-block__pulse" aria-hidden="true" />
        <span className="run-block__action-text">{state.actionText}</span>
      </p>

      <div className="agent-controls agent-controls--inline">
        {paused ? (
          <button type="button" className="btn-control btn-control--resume" onClick={onResume}>
            <Play size={14} aria-hidden="true" />
            Resume
          </button>
        ) : (
          <button type="button" className="btn-control btn-control--pause" onClick={onPause}>
            <Pause size={14} aria-hidden="true" />
            Pause
          </button>
        )}
        <button type="button" className="btn-control btn-control--stop" onClick={onStop}>
          <Square size={14} aria-hidden="true" />
          Stop
        </button>
      </div>
    </section>
  );
}