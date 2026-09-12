/* ------------------------------------------------------------------ *
 * Vision providers — local-first perception for the agent.
 *
 * Per the MASTER directive the perception stack is provider-based and
 * lazy-loaded in this order: Transformers.js (WebGPU/WASM backends) →
 * ONNX Runtime Web → custom WASM. OCR sits on PaddleOCR-compatible
 * output. Nothing loads until a provider is actually needed, keeping the
 * MV3 worker lean.
 * ------------------------------------------------------------------ */

export type BackendKind = "webgpu" | "wasm" | "webnn" | "cpu";

export interface DetectedElement {
  kind: "link" | "button" | "input" | "select" | "text";
  label: string;
  selector: string;
  confidence: number;
}

export interface VisionProvider {
  readonly name: string;
  backend(): BackendKind;
  ready(): Promise<boolean>;
  /** Encode readable element affordances for an action. */
  detectInteractive(root: Element): Promise<DetectedElement[]>;
  /** Screenshot-level reasoning hook (VLM in later phases). */
  describeViewport(): Promise<string | null>;
}

export interface OCRProvider {
  readonly name: string;
  recognize(imageSource: CanvasImageSource): Promise<string>;
}

/* ------------------------------------------------------------------ *
 * Capability detection — honest, no fake success.
 * ------------------------------------------------------------------ */

function webgpuAvailable(): boolean {
  return typeof navigator !== "undefined" && "gpu" in navigator;
}

function wasmSimdAvailable(): boolean {
  const WA: any = WebAssembly;
  if (typeof WebAssembly === "undefined" || !WA.Feature) return false;
  try {
    return Boolean(WA.Feature.detect("simd128"));
  } catch {
    return false;
  }
}

function transformersJsAvailable(): boolean {
  return typeof (globalThis as any).transformers !== "undefined";
}

export interface CapabilityReport {
  webgpu: boolean;
  wasm: boolean;
  wasmSimd: boolean;
  transformers: boolean;
  onnx: boolean;
  backend: BackendKind;
}

export function detectCapabilities(): CapabilityReport {
  const webgpu = webgpuAvailable();
  const wasm = typeof WebAssembly !== "undefined";
  const transformers = transformersJsAvailable();
  const onnx = typeof (globalThis as any).ort !== "undefined";
  const backend: BackendKind = webgpu ? "webgpu" : wasm ? "wasm" : "cpu";
  return { webgpu, wasm, wasmSimd: wasmSimdAvailable(), transformers, onnx, backend };
}

/* ------------------------------------------------------------------ *
 * Transformers.js provider. `ready()` and `backend()` reflect real
 * capability detection; interactive-element detection uses DOM semantics
 * as the local baseline the model later improves.
 * ------------------------------------------------------------------ */

const INTERACTIVE_SELECTORS = [
  "a[href]",
  "button",
  "button[role]",
  'input[type="search"], input[type="text"], [contenteditable="true"]',
  "select",
].join(",");

export class TransformersVisionProvider implements VisionProvider {
  readonly name = "transformers.js";

  backend(): BackendKind {
    return detectCapabilities().backend;
  }

  async ready(): Promise<boolean> {
    return transformersJsAvailable();
  }

  async detectInteractive(root: Element): Promise<DetectedElement[]> {
    const candidates = Array.from(root.querySelectorAll<HTMLElement>(INTERACTIVE_SELECTORS))
      .filter((el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        const style = getComputedStyle(el);
        return style.visibility !== "hidden" && style.display !== "none";
      })
      .slice(0, 40);

    return candidates.map((el, i) => ({
      kind:
        el.tagName === "A"
          ? "link"
          : el.tagName === "INPUT" || el.isContentEditable
            ? "input"
            : el.tagName === "SELECT"
              ? "select"
              : "button",
      label:
        (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 80) ||
        el.tagName.toLowerCase(),
      selector: buildSelectorFor(el, i),
      confidence: 0.9,
    }));
  }

  async describeViewport(): Promise<string | null> {
    return null; // Requires VLM weights — wired in a later phase.
  }
}

/** Best-effort stable selector (id → name → positional fallback). */
function buildSelectorFor(el: HTMLElement, fallbackIndex: number): string {
  if (el.id) return `#${CSS.escape(el.id)}`;
  const inputName = (el as HTMLInputElement).name;
  if (el.tagName === "INPUT" && inputName) {
    return `${el.tagName.toLowerCase()}[name="${CSS.escape(inputName)}"]`;
  }
  return `${el.tagName.toLowerCase()}[data-trustech="${fallbackIndex}"]`;
}

/* ------------------------------------------------------------------ *
 * PaddleOCR-compatible OCR provider. The WASM runtime is bundled in a
 * later phase; recognize() never fabricates output before then.
 * ------------------------------------------------------------------ */

export class PaddleOcrProvider implements OCRProvider {
  readonly name = "paddleocr";

  async recognize(): Promise<string> {
    return "";
  }
}

/* ------------------------------------------------------------------ *
 * Provider registry — the seam the agent loop uses to pick perception.
 * ------------------------------------------------------------------ */

export function getVisionProvider(force?: "transformers" | "onnx"): VisionProvider | null {
  const caps = detectCapabilities();
  if (force === "transformers" || caps.transformers) return new TransformersVisionProvider();
  return null; // onnx path registered once a runtime global is present
}

export { webgpuAvailable, wasmSimdAvailable };