import type { VisionBackend } from "./types";

export type TransformersModule = typeof import("@huggingface/transformers");

let transformersP: Promise<TransformersModule> | null = null;

export function getTransformers(): Promise<TransformersModule> {
  if (!transformersP) {
    transformersP = import("@huggingface/transformers");
  }
  return transformersP;
}

export interface OfflineRuntimeOptions {
  /** Base path where bundled model assets live (e.g. chrome-extension://<id>/models/). */
  modelBase: string;
  /** Base path where bundled onnxruntime WASM lives. Ignored on node. */
  wasmBase?: string;
  allowRemoteModels?: boolean;
}

export async function configureOfflineRuntime(options: OfflineRuntimeOptions): Promise<void> {
  const { env } = await getTransformers();
  env.allowRemoteModels = options.allowRemoteModels ?? false;
  env.allowLocalModels = true;
  env.localModelPath = options.modelBase;
  const wasmBase = options.wasmBase;
  if (wasmBase) {
    try {
      (env.backends.onnx as never as { wasm?: { wasmPaths?: string } }).wasm = {
        wasmPaths: wasmBase,
      };
    } catch {
      /* non-wasm runtime (node) ignores this */
    }
  }
}

export function resolveExtensionModelBase(getURL?: (path: string) => string): string {
  if (getURL) return getURL("models/");
  try {
    const chromeAny = (globalThis as never as { chrome?: { runtime?: { getURL?: (p: string) => string } } }).chrome;
    if (chromeAny?.runtime?.getURL) return chromeAny.runtime.getURL("models/");
  } catch {
    /* no extension api */
  }
  return "models/";
}

export function resolveExtensionWasmBase(getURL?: (path: string) => string): string | undefined {
  if (getURL) return getURL("wasm/");
  try {
    const chromeAny = (globalThis as never as { chrome?: { runtime?: { getURL?: (p: string) => string } } }).chrome;
    if (chromeAny?.runtime?.getURL) return chromeAny.runtime.getURL("wasm/");
  } catch {
    /* no extension api */
  }
  return undefined;
}

export interface VisionModelSession {
  modelName: string;
  backend: VisionBackend;
  forward: (pixelValues: unknown) => Promise<{
    logits: { data: Float32Array; dims: number[] };
    pred_boxes: { data: Float32Array; dims: number[] };
  }>;
  dispose: () => Promise<void>;
}