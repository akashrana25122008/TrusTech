import { Globe } from "lucide-react";
import type { Telemetry } from "@/shared/types";

export function BrowserContext({ telemetry }: { telemetry: Telemetry }) {
  return (
    <section className="browser-ctx">
      <div className="block-eyebrow">BROWSER CONTEXT</div>
      <div className="ctx-card">
        <div className="ctx-card__main">
          <span className="ctx-card__icon">
            <Globe size={14} />
          </span>
          <span className="ctx-card__label">ACTIVE TAB</span>
          <span className="ctx-card__value">{telemetry.currentTab}</span>
        </div>
        <div className="ctx-card__url">{telemetry.currentUrl || "local page"}</div>
      </div>
      <div className="ctx-switcher">
        {["Your page", "Search", "Results"].map((t, i) => (
          <span key={t} className={`ctx-pip ${i === 0 ? "is-active" : ""}`}>
            {t}
          </span>
        ))}
        <span className="ctx-note">tab switching via agent</span>
      </div>
    </section>
  );
}