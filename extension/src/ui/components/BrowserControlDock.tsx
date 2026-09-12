import { useCallback, useEffect, useRef, useState } from "react";
import {
  Plus,
  X,
  Layers,
  ArrowLeft,
  ArrowRight,
  RotateCw,
  MoveVertical,
  MousePointerClick,
  Keyboard,
  ScanText,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { InjectActionCommand } from "@/shared/types";

export interface DockItem {
  cmd: InjectActionCommand;
  label: string;
  icon: LucideIcon;
  kind: "tab" | "nav" | "interact";
}

const ITEMS: DockItem[] = [
  { cmd: "newTab", label: "New Tab", icon: Plus, kind: "tab" },
  { cmd: "closeTab", label: "Close Tab", icon: X, kind: "tab" },
  { cmd: "back", label: "Back", icon: ArrowLeft, kind: "nav" },
  { cmd: "forward", label: "Forward", icon: ArrowRight, kind: "nav" },
  { cmd: "reload", label: "Reload", icon: RotateCw, kind: "nav" },
  { cmd: "scroll", label: "Scroll", icon: MoveVertical, kind: "interact" },
  { cmd: "click", label: "Click", icon: MousePointerClick, kind: "interact" },
  { cmd: "type", label: "Type", icon: Keyboard, kind: "interact" },
  { cmd: "select", label: "Select", icon: ScanText, kind: "interact" },
];

/** Retract animation length (ms) — must match the CSS exit keyframes. */
const RETRACT_MS = 240;

type DockPhase = "closed" | "open" | "closing";

/**
 * BrowserControlDock — compact floating control module. Collapsed it shows
 * only the ">" trigger; expanding floats the nine browser controls out to
 * the right with a stagger. All commands route to the SAME onCommand
 * handler as before — presentation only, zero functional change.
 */
export function BrowserControlDock({ onCommand, active }: { onCommand: (cmd: InjectActionCommand) => void; active: boolean }) {
  const [phase, setPhase] = useState<DockPhase>("closed");
  const rootRef = useRef<HTMLElement | null>(null);
  const retractTimer = useRef<number | undefined>(undefined);

  const open = useCallback(() => {
    window.clearTimeout(retractTimer.current);
    setPhase("open");
  }, []);

  const collapse = useCallback(() => {
    window.clearTimeout(retractTimer.current);
    setPhase((prev) => {
      if (prev !== "open") return prev;
      retractTimer.current = window.setTimeout(() => setPhase("closed"), RETRACT_MS);
      return "closing";
    });
  }, []);

  const toggle = useCallback(() => {
    if (phase === "open") collapse();
    else open();
  }, [phase, collapse, open]);

  useEffect(() => () => window.clearTimeout(retractTimer.current), []);

  // Dismiss on outside interaction (never on inside clicks) + Escape.
  useEffect(() => {
    if (phase !== "open") return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) collapse();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") collapse();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [phase, collapse]);

  const expanded = phase === "open" || phase === "closing";

  const onTriggerKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle();
    }
  };

  return (
    <section
      ref={rootRef}
      className={`dock-block is-${phase}`}
      data-active={active}
      data-expanded={expanded}
      aria-label="Browser controls"
    >
      <div className="block-eyebrow">BROWSER CONTROL</div>
      <div className="dock-float">
        <button
          type="button"
          className="dock-trigger"
          onClick={toggle}
          onKeyDown={onTriggerKeyDown}
          aria-expanded={phase === "open"}
          aria-label={phase === "open" ? "Collapse browser controls" : "Expand browser controls"}
          title={phase === "open" ? "Collapse" : "Browser controls"}
        >
          <span className="dock-trigger__glyph" aria-hidden="true">
            {">"}
          </span>
        </button>
        <div className="dock" role={expanded ? "toolbar" : undefined} aria-label={expanded ? "Browser actions" : undefined}>
          {expanded &&
            ITEMS.map((item, i) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.cmd}
                  className={`dock-btn is-${item.kind}`}
                  style={{ "--item-index": i } as React.CSSProperties}
                  onClick={() => onCommand(item.cmd)}
                  title={item.label}
                  aria-label={item.label}
                  aria-hidden={phase !== "open"}
                  tabIndex={phase === "open" ? 0 : -1}
                  disabled={false}
                >
                  <Icon size={15} strokeWidth={2} />
                  <span className="dock-btn__tip">{item.label}</span>
                </button>
              );
            })}
          <span className="dot-tab" aria-hidden="true">
            <Layers size={11} />
          </span>
        </div>
      </div>
    </section>
  );
}
