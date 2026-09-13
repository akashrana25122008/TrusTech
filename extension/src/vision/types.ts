export type VisionBackend = "webgpu" | "wasm" | "cpu";

export type VisionDetectionType = "element" | "text" | "face" | "sensitive";

export interface VisionBBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VisionDetection {
  type: VisionDetectionType;
  bbox: VisionBBox;
  confidence: number;
  label: string;
}

export interface VisionMetrics {
  backend: VisionBackend;
  loadMs: number;
  captureMs: number;
  preprocessMs: number;
  inferenceMs: number;
  postprocessMs: number;
  totalMs: number;
}

export interface VisionRaster {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface VisionCapabilities {
  webgpu: boolean;
  wasmSimd: boolean;
  cpu: boolean;
  worker: boolean;
  offscreenCanvas: boolean;
  host: "chrome" | "firefox" | "unknown";
}

export interface VisionInitConfig {
  modelId: string;
  backend: VisionBackend | "auto";
  threshold: number;
  maxDetections: number;
}

export interface VisionInferRequestPayload {
  id: string;
  width: number;
  height: number;
  data: ArrayBuffer;
  sourceWidth: number;
  sourceHeight: number;
}

export interface VisionInferResult {
  id: string;
  detections: VisionDetection[];
  metrics: VisionMetrics;
  sourceWidth: number;
  sourceHeight: number;
}

export type VisionWorkerRequest =
  | { kind: "INIT"; payload: VisionInitConfig }
  | { kind: "INFER"; payload: VisionInferRequestPayload }
  | { kind: "DISPOSE" };

export type VisionWorkerResponse =
  | { kind: "READY"; payload: { backend: VisionBackend; modelId: string; loadMs: number } }
  | { kind: "INFER_RESULT"; payload: VisionInferResult }
  | { kind: "ERROR"; payload: { id?: string; code: string; message: string } }
  | { kind: "DISPOSED" };