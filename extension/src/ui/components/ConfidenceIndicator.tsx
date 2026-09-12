import { ShieldCheck, Fingerprint, Target } from "lucide-react";
import type { Telemetry } from "@/shared/types";

/* Confidence is emphasized by a soft gauge; the surrounding telemetry
   cells intentionally leave room for Trust / Intent / Memory readings. */

function Ring({ value }: { value: number }) {
  const r = 21;
  const c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 52 52" className="conf-ring" aria-hidden="true">
      <circle cx="26" cy="26" r={r} fill="none" stroke="rgba(140,180,255,0.12)" strokeWidth="3.5" />
      <circle
        cx="26"
        cy="26"
        r={r}
        fill="none"
        stroke="url(#confGrad)"
        strokeWidth="3.5"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - value / 100)}
        transform="rotate(-90 26 26)"
        className="conf-ring__fill"
      />
      <defs>
        <linearGradient id="confGrad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#37d8ff" />
          <stop offset="100%" stopColor="#8b7bff" />
        </linearGradient>
      </defs>
    </svg>
  );
}

const privacyTone = (p: Telemetry["privacy"]) =>
  p === "SAFE" ? "is-green" : p === "SCANNING" ? "is-amber" : "is-red";

const trustTone = (level: NonNullable<Telemetry["trust"]>["level"]) => {
  switch (level) {
    case "VERY_HIGH":
    case "HIGH":
      return "is-green";
    case "CAUTION":
      return "is-amber";
    case "LOW":
      return "is-amber";
    default:
      return "is-red";
  }
};

export function ConfidenceIndicator({ telemetry }: { telemetry: Telemetry }) {
  const trust = telemetry.trust ?? { score: 100, level: "HIGH" as const };
  const cells = [
    { icon: ShieldCheck, k: "Privacy", v: telemetry.privacy, tone: privacyTone(telemetry.privacy) },
    { icon: Fingerprint, k: "Trust", v: `${trust.level} ${trust.score}`, tone: trustTone(trust.level) },
    { icon: Target, k: "Intent", v: "FOCUSED", tone: "is-cyan" },
  ];

  return (
    <section className="conf-block">
      <div className="block-eyebrow">AGENT TELEMETRY</div>
      <div className="conf-grid">
        <div className="conf-ring-wrap">
          <Ring value={telemetry.confidence} />
          <div className="conf-ring-wrap__text">
            <span className="conf-ring-wrap__pct">{Math.round(telemetry.confidence)}</span>
            <span className="conf-ring-wrap__lbl">CONFIDENCE</span>
          </div>
        </div>

        <div className="conf-cells">
          {cells.map((cell) => {
            const Icon = cell.icon;
            return (
              <div key={cell.k} className={`conf-cell ${cell.tone}`}>
                <Icon size={13} aria-hidden="true" />
                <span className="conf-cell__k">{cell.k}</span>
                <span className="conf-cell__v">{cell.v}</span>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}