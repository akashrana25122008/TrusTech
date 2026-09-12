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

export function BrowserControlDock({ onCommand, active }: { onCommand: (cmd: InjectActionCommand) => void; active: boolean }) {
  return (
    <section className="dock-block" data-active={active}>
      <div className="block-eyebrow">BROWSER CONTROL</div>
      <div className="dock">
        {ITEMS.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.cmd}
              className={`dock-btn is-${item.kind}`}
              onClick={() => onCommand(item.cmd)}
              title={item.label}
              aria-label={item.label}
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
    </section>
  );
}