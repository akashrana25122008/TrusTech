import { MODEL_DTYPE, MODEL_ID } from "./model";
import type { TransformersModule } from "./runtime";
import type { VisionBackend } from "./types";

export interface ObjectDetectionResult {
  logits: { data: Float32Array; dims: number[] };
  pred_boxes: { data: Float32Array; dims: number[] };
}

export interface InferenceSession {
  model: unknown;
  processor: unknown;
  modelName: string;
  backend: VisionBackend;
}

export async function createDetectionSession(
  T: TransformersModule,
  backend: VisionBackend,
): Promise<{ session: InferenceSession; loadMs: number }> {
  const start = performance.now();
  const model = await T.AutoModelForObjectDetection.from_pretrained(MODEL_ID, {
    dtype: MODEL_DTYPE,
    device: backend === "cpu" ? undefined : backend,
    local_files_only: true,
  });
  const processor = await T.AutoProcessor.from_pretrained(MODEL_ID, {
    local_files_only: true,
  });
  return { session: { model, processor, modelName: MODEL_ID, backend }, loadMs: performance.now() - start };
}

export async function runDetectionInference(
  session: InferenceSession,
  pixelValues: unknown,
): Promise<{ output: ObjectDetectionResult; inferenceMs: number }> {
  const start = performance.now();
  const output = await (session.model as { (inputs: { pixel_values: unknown }): Promise<ObjectDetectionResult> })({
    pixel_values: pixelValues,
  });
  return { output, inferenceMs: performance.now() - start };
}