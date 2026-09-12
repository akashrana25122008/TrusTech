import { useEffect, useRef, useState } from "react";

/* ------------------------------------------------------------------ *
 * Subtle pointer parallax for the whole chamber. Returns normalised
 * pointer position in [-1, 1] plus a CSS transform usable on any layer.
 * ------------------------------------------------------------------ */

export interface Parallax {
  nx: number;
  ny: number;
  transform(depth: number): string;
}

export function useParallax(sheetSize = 40): Parallax {
  const [pointer, setPointer] = useState({ nx: 0, ny: 0 });
  const raf = useRef<number>(0);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const nx = (e.clientX / window.innerWidth) * 2 - 1;
      const ny = (e.clientY / window.innerHeight) * 2 - 1;
      raf.current = requestAnimationFrame(() => setPointer({ nx, ny }));
    };
    const el = document.getElementById("root");
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      cancelAnimationFrame(raf.current);
      void el;
    };
  }, []);

  return {
    ...pointer,
    transform: (depth: number) =>
      `perspective(900px) translate3d(${(pointer.nx * sheetSize) / depth / 2}px, ${(pointer.ny * sheetSize) / depth / 2}px, 0) rotateX(${(-pointer.ny * 1.5) / depth}deg) rotateY(${(pointer.nx * 1.5) / depth}deg)`,
  };
}