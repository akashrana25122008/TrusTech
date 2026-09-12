/* ------------------------------------------------------------------ *
 * RecoveryManager — bounded retry strategies when an action fails or
 * verification fails. Prevents infinite loops; escalates to the user
 * after exhausting attempts.
 * ------------------------------------------------------------------ */

export type RecoveryAction =
  | { kind: "retry_same" }
  | { kind: "reobserve_then_retry" }
  | { kind: "navigate_back" }
  | { kind: "switch_tab" }
  | { kind: "ask_user"; reason: string }
  | { kind: "give_up"; reason: string };

export class RecoveryManager {
  private retries = 0;
  private readonly max: number;

  constructor(maxRetries = 3) {
    this.max = maxRetries;
  }

  get attempt(): number {
    return this.retries;
  }

  get exhausted(): boolean {
    return this.retries > this.max;
  }

  plan(failureReason: string): RecoveryAction {
    this.retries++;

    if (this.exhausted) {
      return { kind: "give_up", reason: `exhausted ${this.max} retries: ${failureReason}` };
    }

    if (/stale|detached|not in the DOM|not found/.test(failureReason)) {
      return { kind: "reobserve_then_retry" };
    }
    if (/url|navigation|page.*load|timeout/i.test(failureReason)) {
      return { kind: "reobserve_then_retry" };
    }

    // Generic retry with fresh observation.
    return { kind: "reobserve_then_retry" };
  }

  reset(): void {
    this.retries = 0;
  }
}