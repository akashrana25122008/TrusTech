/**
 * Floating browser-control dock: collapsed trigger, staggered deploy,
 * collapse/Escape/outside dismissal, and intact command routing.
 * Uses react-dom directly (no testing library in this repo).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { BrowserControlDock } from "@/ui/components/BrowserControlDock";
import type { InjectActionCommand } from "@/shared/types";

// @ts-expect-error test env flag for act()
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const CMDS: InjectActionCommand[] = [
  "newTab",
  "closeTab",
  "back",
  "forward",
  "reload",
  "scroll",
  "click",
  "type",
  "select",
];

let host: HTMLDivElement;
let root: Root | null = null;

function renderDock(onCommand: (cmd: InjectActionCommand) => void) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(<BrowserControlDock onCommand={onCommand} active={false} />);
  });
  return host;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function commandButtons(): HTMLButtonElement[] {
  return Array.from(host.querySelectorAll("button.dock-btn")) as HTMLButtonElement[];
}

function trigger(): HTMLButtonElement {
  const el = host.querySelector("button.dock-trigger") as HTMLButtonElement | null;
  if (!el) throw new Error("dock trigger missing");
  return el;
}

function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  document.body.innerHTML = "";
});

describe("BrowserControlDock floating module", () => {
  it("starts collapsed showing only the trigger", () => {
    renderDock(() => undefined);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(trigger().getAttribute("aria-label")).toBe("Expand browser controls");
    expect(commandButtons()).toHaveLength(0);
  });

  it("deploys all nine controls with labels on trigger click", () => {
    renderDock(() => undefined);
    click(trigger());
    const btns = commandButtons();
    expect(btns).toHaveLength(9);
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    for (const label of ["New Tab", "Close Tab", "Back", "Forward", "Reload", "Scroll", "Click", "Type", "Select"]) {
      expect(btns.some((b) => b.getAttribute("aria-label") === label)).toBe(true);
    }
  });

  it("routes every control to the original onCommand handler", () => {
    const seen: InjectActionCommand[] = [];
    renderDock((cmd) => seen.push(cmd));
    click(trigger());
    for (const btn of commandButtons()) {
      click(btn);
    }
    expect(seen).toEqual(CMDS);
  });

  it("retracts into the trigger on second click", async () => {
    renderDock(() => undefined);
    click(trigger());
    expect(commandButtons()).toHaveLength(9);
    click(trigger());
    await sleep(350);
    act(() => undefined);
    expect(commandButtons()).toHaveLength(0);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("collapses on Escape", async () => {
    renderDock(() => undefined);
    click(trigger());
    expect(commandButtons()).toHaveLength(9);
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await sleep(350);
    act(() => undefined);
    expect(commandButtons()).toHaveLength(0);
  });

  it("collapses on outside pointer interaction, not inside clicks", async () => {
    const seen: InjectActionCommand[] = [];
    renderDock((cmd) => seen.push(cmd));
    click(trigger());
    const btns = commandButtons();
    // Inside click: command fires, dock stays open.
    click(btns[0]);
    expect(seen).toEqual(["newTab"]);
    expect(commandButtons()).toHaveLength(9);
    // Outside click: dock retracts.
    act(() => {
      document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    await sleep(350);
    act(() => undefined);
    expect(commandButtons()).toHaveLength(0);
  });

  it("expanded controls are keyboard-focusable with staggered indices", () => {
    renderDock(() => undefined);
    click(trigger());
    const btns = commandButtons();
    expect(btns.every((b) => b.tabIndex === 0)).toBe(true);
    const delays = btns.map((b) => b.style.getPropertyValue("--item-index"));
    expect(delays).toEqual(["0", "1", "2", "3", "4", "5", "6", "7", "8"]);
  });
});
