import { CheckCircle2, Eye, XCircle } from "lucide-react";
import type { AgentState } from "@/shared/types";

/* ------------------------------------------------------------------ *
 * VerificationPanel — execution-complete is not objective-complete.
 * Shows verified outcomes (from structured verify events), the manual
 * verification state, and — while awaiting — the required human step.
 * The Objective met / Not met buttons live in Panel; this panel only
 * reflects state, never duplicates handlers.
 * ------------------------------------------------------------------ */

export function VerificationPanel({ state }: { state: AgentState }) {
  const oks = state.log.filter((e) => e.event?.kind === "verify-ok");
  const fails = state.log.filter((e) => e.event?.kind === "verify-fail");
  const hasEvidence = oks.length > 0 || fails.length > 0;

  return (
    <section className="timeline-block" aria-label="Verification">
      <div className="block-eyebrow">VERIFICATION</div>
      {state.status === "AWAITING_VERIFY" && (
        <div className="pd-verify-callout" role="note">
          <Eye size={13} aria-hidden="true" />
          <div>
            <p className="pd-verify-callout__title">VERIFICATION REQUIRED</p>
            <p className="pd-verify-callout__text">
              TrusTech finished the planned browser actions. Please verify the result on the page, then confirm above.
            </p>
          </div>
        </div>
      )}
      {state.status === "VERIFIED" && (
        <div className="pd-verify-result is-green">
          <CheckCircle2 size={13} aria-hidden="true" />
          <span>Objective verified — VERIFIED_SUCCESS</span>
        </div>
      )}
      {state.status === "VERIFY_FAILED" && (
        <div className="pd-verify-result is-red">
          <XCircle size={13} aria-hidden="true" />
          <span title={state.actionText}>Objective rejected — VERIFIED_FAILED</span>
        </div>
      )}
      {!hasEvidence && state.status !== "AWAITING_VERIFY" && state.status !== "VERIFIED" && state.status !== "VERIFY_FAILED" && (
        <div className="timeline-empty">No verified outcomes yet.</div>
      )}
      {hasEvidence && (
        <ul className="pd-verify-list">
          {[...fails.slice(-3), ...oks.slice(-5)].map((e) => {
            const ok = e.event?.kind === "verify-ok";
            return (
              <li key={e.id} className={`pd-verify-list__item is-${ok ? "ok" : "fail"}`}>
                {ok ? <CheckCircle2 size={11} aria-hidden="true" /> : <XCircle size={11} aria-hidden="true" />}
                <span className="pd-verify-list__text" title={e.text}>
                  {e.event?.spec ?? e.text}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
