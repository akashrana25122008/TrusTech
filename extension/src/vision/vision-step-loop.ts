import { requestVisionGrounding, type VisionStepClientOptions, type VisionStepResult } from "./vision-step-client";
import type { VisionStatus } from "./vision-step-response";

export interface VisionLoopOptions extends VisionStepClientOptions {
  maxIterations?: number;
  stopOnCompletion?: boolean;
}

export interface VisionLoopOutcome {
  iterations: number;
  completed: boolean;
  stoppedBy: VisionStatus | "max_iterations" | "transport_block" | "invalid_response";
  last: VisionStepResult;
}

const REPEAT_STATES: ReadonlySet<VisionStatus> = new Set(["target_not_found", "low_confidence", "blocked_by_privacy"]);

export async function runVisionStepLoop(options: VisionLoopOptions): Promise<VisionLoopOutcome> {
  const max = Math.max(1, Math.min(10, options.maxIterations ?? 3));
  const stopOnCompletion = options.stopOnCompletion ?? true;
  const repeats = new Map<VisionStatus, number>();
  let last: VisionStepResult = { ok: false, reason: "not started", requestCount: 0 };
  let i = 0;
  for (; i < max; i++) {
    last = await requestVisionGrounding(options);
    if (!last.ok) {
      return { iterations: i + 1, completed: false, stoppedBy: last.code === undefined ? "invalid_response" : "transport_block", last };
    }
    const response = last.validated;
    if (!response) return { iterations: i + 1, completed: false, stoppedBy: "invalid_response", last };
    if (stopOnCompletion && (response.completion || response.actions.length > 0)) {
      return { iterations: i + 1, completed: response.completion, stoppedBy: response.status, last };
    }
    if (!REPEAT_STATES.has(response.status)) {
      return { iterations: i + 1, completed: false, stoppedBy: response.status, last };
    }
    const count = (repeats.get(response.status) ?? 0) + 1;
    repeats.set(response.status, count);
    if (count >= 2) return { iterations: i + 1, completed: false, stoppedBy: response.status, last };
  }
  return { iterations: i, completed: false, stoppedBy: "max_iterations", last };
}
