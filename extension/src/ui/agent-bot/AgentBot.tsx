import { useEffect, useRef } from "react";
import { createAgentBotScene, type AgentBotSceneHandle } from "./agentAvatarScene";
import type { BotState } from "./types";

/* ------------------------------------------------------------------ *
 * AgentBot — mounts the Interview Mentor "AI interviewer" avatar on a
 * container and keeps it in sync with a clean BotState + pointer
 * parallax. Renders independently of React's render cycle.
 * ------------------------------------------------------------------ */

export interface AgentBotHandle {
  setMode(mode: BotState): void;
  setPointer(nx: number, ny: number): void;
}

export function AgentBot({ state, onReady }: { state: BotState; onReady?: (h: AgentBotHandle) => void }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<AgentBotSceneHandle | null>(null);

  const low =
    (typeof navigator !== "undefined" &&
      (navigator.hardwareConcurrency || 8) <= 4) ||
    (typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches) ||
    (typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches);

  useEffect(() => {
    const el = mountRef.current;
    if (!el) return;

    const scene = createAgentBotScene(el, low);
    handleRef.current = scene;
    scene.setMode(state);
    onReady?.({
      setMode: (m) => scene.setMode(m),
      setPointer: (nx, ny) => scene.setPointer(nx, ny),
    });

    const onPointer = (e: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      const ny = ((e.clientY - rect.top) / rect.height) * 2 - 1;
      scene.setPointer(nx, ny);
    };
    el.addEventListener("pointermove", onPointer, { passive: true });

    return () => {
      el.removeEventListener("pointermove", onPointer);
      scene.dispose();
      handleRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    handleRef.current?.setMode(state);
  }, [state]);

  return <div ref={mountRef} className="agent-canvas" aria-hidden="true" />;
}