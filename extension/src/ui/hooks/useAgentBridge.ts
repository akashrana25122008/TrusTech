import { useCallback, useRef } from "react";
import type { ExtensionMessage, AgentStateKey } from "@/shared/types";

/* ------------------------------------------------------------------ *
 * Bridge between the panel and the extension runtime.
 * In plain-browser dev the chrome namespace is absent ⇒ graceful no-op.
 * ------------------------------------------------------------------ */

const runtime: any =
  (typeof chrome !== "undefined" && chrome?.runtime) ||
  (typeof browser !== "undefined" && browser?.runtime) ||
  null;

/** Broadcast to the agent's active tab via the background service worker. */
export function sendToBackground(message: ExtensionMessage) {
  try {
    runtime?.sendMessage(message);
  } catch {
    /* dev preview — ignore */
  }
}

export function useAgentBridge() {
  const timer = useRef<number | null>(null);

  const clearTimers = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  /** Push the agent's visual state to the page (status pill + beam). */
  const pushState = useCallback(
    (status: AgentStateKey, actionText: string) => {
      sendToBackground({ type: "AGENT_STATE", payload: { status, actionText } });
    },
    [],
  );

  const highlight = useCallback(
    (kind: any, label: string, selector?: string) => {
      sendToBackground({ type: "AGENT_HIGHLIGHT", payload: { kind, label, selector } });
    },
    [],
  );

  const beam = useCallback(
    (on: boolean, selector?: string) => {
      if (on) {
        sendToBackground({ type: "AGENT_BEAM", payload: { on, selector } });
        if (timer.current) clearTimeout(timer.current);
        timer.current = window.setTimeout(() => {
          sendToBackground({ type: "AGENT_BEAM", payload: { on: false } });
        }, 1400);
      } else {
        if (timer.current) clearTimeout(timer.current);
        sendToBackground({ type: "AGENT_BEAM", payload: { on: false } });
      }
    },
    [clearTimers],
  );

  const command = useCallback((cmd: any, selector?: string, value?: string) => {
    sendToBackground({ type: "BROWSER_COMMAND", payload: { command: cmd, selector, value } });
  }, []);

  return { pushState, highlight, beam, command };
}