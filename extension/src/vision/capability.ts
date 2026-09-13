import type { VisionBackend, VisionCapabilities } from "./types";

/** Detect the best available backend from the current global scope. */
export function detectVisionCapabilities(scope: {
  navigator?: { userAgent?: string; gpu?: unknown };
  WebAssembly?: { validate(source: Uint8Array): boolean };
} = globalThis as never): VisionCapabilities {
  const nav = scope.navigator as never as { userAgent?: string; gpu?: never };
  const wasm = scope.WebAssembly;
  const ua = nav?.userAgent ?? "";
  const host = /Firefox/.test(ua) ? "firefox" : /Chrome|Chromium|Edg/.test(ua) ? "chrome" : "unknown";

  return {
    webgpu: typeof nav?.gpu !== "undefined",
    wasmSimd: !!wasm && typeof wasm.validate === "function",
    cpu: true,
    worker: typeof Worker !== "undefined",
    offscreenCanvas: typeof OffscreenCanvas !== "undefined",
    host,
  };
}

export function pickBackend(caps: VisionCapabilities, preferred: VisionBackend | "auto"): VisionBackend {
  if (preferred !== "auto") return preferred;
  if (caps.webgpu) return "webgpu";
  if (caps.wasmSimd) return "wasm";
  return "cpu";
}