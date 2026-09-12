import { useCallback, useState } from "react";
import { Header } from "./Header";
import { RobotStage } from "./RobotStage";
import { TaskInput } from "./TaskInput";
import { LiveAgentControls } from "./LiveAgentControls";
import { ProcessingDetails } from "./ProcessingDetails";
import { BrowserControlDock } from "./BrowserControlDock";
import { useAgentState } from "@/ui/hooks/useAgentState";
import { useAgentBridge } from "@/ui/hooks/useAgentBridge";
import { mapAgentToBot } from "@/ui/agent-bot/bot-state-adapter";
import { displayActionText } from "./statusText";
import type { InjectActionCommand } from "@/shared/types";
import { Lock } from "lucide-react";

/* ------------------------------------------------------------------ *
 * Panel — minimal AI-companion landing view.
 *
 * Visual hierarchy: bot hero → current task → current action →
 * composer → processing-details drawer → pause/stop. Everything
 * technical lives inside the collapsed drawer; the hero, task line,
 * action line and controls are all driven by real agent state.
 * ------------------------------------------------------------------ */

export function Panel() {
  const bridge = useAgentBridge();
  const { state, startTask, stop, pause, resume, verifyObjective, clearLog } = useAgentState(bridge);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const running =
    state.status !== "IDLE" &&
    state.status !== "SUCCESS" &&
    state.status !== "ERROR" &&
    state.status !== "WAITING" &&
    state.status !== "AWAITING_VERIFY" &&
    state.status !== "VERIFIED" &&
    state.status !== "VERIFY_FAILED";

  // Execution-complete and verified outcomes are terminal for controls:
  // a new task starts from the composer, never by re-running silently.
  const terminal =
    state.status === "SUCCESS" ||
    state.status === "ERROR" ||
    state.status === "VERIFIED" ||
    state.status === "VERIFY_FAILED";
  const idle = state.status === "IDLE";
  const awaitingVerify = state.status === "AWAITING_VERIFY";

  const handleTask = useCallback(
    (task: string) => {
      startTask(task);
    },
    [startTask],
  );

  const handleCommand = useCallback(
    (cmd: InjectActionCommand) => {
      bridge.command(cmd);
      if (state.status === "IDLE" && cmd === "newTab") {
        startTask(`Open a fresh tab`);
      }
    },
    [bridge, state.status, startTask],
  );

  return (
    <div className="panel-shell" data-status={state.status} data-details={detailsOpen ? "open" : "closed"}>
      <div className="bg-layers" aria-hidden="true">
        <span className="bg-starfield" />
        <span className="bg-nebula" />
        <span className="bg-vignette" />
        <span className="bg-sweep" />
      </div>

      <Header status={state.status} />

      <main className="home">
        <RobotStage
          mode={state.status}
          onChamberReady={(h) => h.setMode(mapAgentToBot(state.status))}
        />

        {!idle && (
          <section className="now" aria-live="polite">
            {state.task ? <h1 className="now__task">{state.task}</h1> : null}
            <p className="now__action" data-status={state.status}>
              <span className="now__pulse" aria-hidden="true" />
              <span className="now__action-text">{displayActionText(state.status, state.actionText)}</span>
            </p>
          </section>
        )}

        {(idle || terminal) && (
          <TaskInput onSubmit={handleTask} disabled={false} />
        )}

        {!idle && !terminal && !awaitingVerify && (
          <LiveAgentControls
            state={state}
            onPause={pause}
            onResume={resume}
            onStop={stop}
          />
        )}

        {awaitingVerify && (
          <div className="confirm-bar" role="group" aria-label="Verify the executed result">
            <div className="confirm-bar__msg">
              <span>
                Execution complete — all planned browser actions ran. Please inspect the page yourself, then confirm the objective.
              </span>
            </div>
            <div className="confirm-bar__actions">
              <button
                type="button"
                className="btn-control btn-control--resume"
                onClick={() => verifyObjective(true)}
                aria-label="Confirm the objective was accomplished"
              >
                Objective met
              </button>
              <button
                type="button"
                className="btn-control btn-control--stop"
                onClick={() => verifyObjective(false, state.actionText)}
                aria-label="Report that the objective was not accomplished"
              >
                Not met
              </button>
            </div>
          </div>
        )}

        {awaitingVerify && (
          <div className="run-block" data-status={state.status}>
            <button type="button" className="btn-control" onClick={stop} aria-label="Discard this task">
              Discard
            </button>
          </div>
        )}

        {state.status === "WAITING" && (
          <div className="confirm-bar" role="alert" aria-describedby="confirm-bar-detail">
            <div className="confirm-bar__msg" id="confirm-bar-detail">
              <Lock size={12} aria-hidden="true" />
              <span>
                {state.risk?.label ?? "Agent is ready to continue"}
                {state.risk && state.risk.reasons.length > 0 && (
                  <span className="confirm-bar__reasons">{state.risk.reasons.join(" · ")}</span>
                )}
              </span>
            </div>
            <div className="confirm-bar__actions">
              <button type="button" className="btn-control btn-control--resume" onClick={resume} aria-label="Approve this action">
                Approve
              </button>
              <button type="button" className="btn-control btn-control--stop" onClick={stop} aria-label="Reject this action and stop">
                Reject
              </button>
            </div>
          </div>
        )}

        <div className="details-slot">
          <ProcessingDetails state={state} onClearLog={clearLog} open={detailsOpen} onToggle={setDetailsOpen} />
        </div>
      </main>

      <div className="dock-footer">
        <BrowserControlDock onCommand={handleCommand} active={running} />
      </div>
    </div>
  );
}
