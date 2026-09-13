import { detectVisionCapabilities, pickBackend } from "@/vision/capability";
import { decodeDetections, toDetections } from "@/vision/detector";
import { createDetectionSession, runDetectionInference } from "@/vision/inference";
import { DEFAULT_MAX_DETECTIONS, DEFAULT_THRESHOLD } from "@/vision/model";
import { preprocessRaster } from "@/vision/preprocess";
import { configureOfflineRuntime, resolveExtensionModelBase, resolveExtensionWasmBase } from "@/vision/runtime";
import type {
  VisionBackend,
  VisionCapabilities,
  VisionDetection,
  VisionMetrics,
} from "@/vision/types";

export interface EngineInitInput {
  modelBase?: string;
  wasmBase?: string;
  capabilities?: VisionCapabilities;
  getURL?: (path: string) => string;
  backend?: VisionBackend;
}

export interface EngineInitResult {
  modelId: string;
  backend: VisionBackend;
  loadMs: number;
}

export interface EngineInferResult {
  detections: VisionDetection[];
  metrics: VisionMetrics;
  sourceWidth: number;
  sourceHeight: number;
}

export class VisionEngine {
  private configured = false;
  private session: Awaited<ReturnType<typeof createDetectionSession>>["session"] | null = null;

  async init(input: EngineInitInput = {}): Promise<EngineInitResult> {
    if (!this.configured) {
      const modelBase = input.modelBase ?? resolveExtensionModelBase(input.getURL);
      const wasmBase = input.wasmBase ?? resolveExtensionWasmBase(input.getURL);
      await configureOfflineRuntime({ modelBase, wasmBase });
      this.configured = true;
    }

    const caps = input.capabilities ?? detectVisionCapabilities();
    const backend = pickBackend(caps, input.backend ?? "auto");

    const T = await import("@huggingface/transformers");
    const { session, loadMs } = await createDetectionSession(T, backend);
    this.session = session;
    return { modelId: session.modelName, backend: session.backend, loadMs };
  }

  async infer(input: {
    id: string;
    width: number;
    height: number;
    data: Uint8ClampedArray;
    sourceWidth: number;
    sourceHeight: number;
  }): Promise<EngineInferResult> {
    if (!this.session) throw new Error("VisionEngine not initialized");

    const T = await import("@huggingface/transformers");
    const startAll = performance.now();
    const { pixelValues, prepMs } = await preprocessRaster(
      T,
      { width: input.width, height: input.height, data: input.data },
      this.session.processor as never,
    );
    const { output, inferenceMs } = await runDetectionInference(this.session, pixelValues);
    const startPost = performance.now();

    const dims = output.logits.dims;
    const predDims = output.pred_boxes.dims;
    const lastQueries = dims.length >= 2 ? dims[dims.length - 2] : 100;
    const lastClasses = dims.length >= 1 ? dims[dims.length - 1] : 1;
    if (predDims.length < 2 || predDims[predDims.length - 1] !== 4) {
      throw new Error(`Unexpected pred_boxes shape: [${predDims.join(",")}]`);
    }
    // Flatten a possibly-batched [B, Q, C] / [B, Q, 4] into the decoder's
    // row-major layout — the ONNX tensor data is laid out contiguously.
    const numQueries = lastQueries;
    const numClasses = lastClasses;

    const decoded = decodeDetections({
      logits: output.logits.data,
      predBoxes: output.pred_boxes.data,
      numQueries,
      numClasses,
      width: input.sourceWidth,
      height: input.sourceHeight,
      threshold: DEFAULT_THRESHOLD,
      maxDetections: DEFAULT_MAX_DETECTIONS,
      nmsIouThreshold: 0.5,
    });
    const detections = toDetections(decoded, input.sourceWidth, input.sourceHeight, DEFAULT_MAX_DETECTIONS, 0.5);
    const postprocessMs = performance.now() - startPost;
    const totalMs = performance.now() - startAll;

    return {
      detections,
      metrics: {
        backend: this.session.backend,
        loadMs: 0,
        captureMs: 0,
        preprocessMs: prepMs,
        inferenceMs,
        postprocessMs,
        totalMs,
      },
      sourceWidth: input.sourceWidth,
      sourceHeight: input.sourceHeight,
    };
  }

  async dispose(): Promise<void> {
    if (this.session) {
      const model = (this.session.model as { dispose?: () => Promise<void> | void }) ?? null;
      await model?.dispose?.();
      this.session = null;
    }
  }

  get initialized(): boolean {
    return this.session !== null;
  }
}