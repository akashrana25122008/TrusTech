import { describe, it, expect } from "vitest";
import { buildVisualPayload } from "@/privacy/visual-transmission";
import { validateVisionStepResponse } from "@/vision/vision-step-response";
import { ALL_ACTION_NAMES } from "@/shared/action-schema";
import { RawCapture, sanitizeImage } from "@/privacy/sanitized-image";
import { buildVisionMetadata } from "@/privacy/vision-metadata";
import type { SensitiveRegion } from "@/privacy/regions";

describe("frontend/backend vision_step contract", () => {
  it("request keys match the backend VisualIntake shape", async () => {
    const data = new Uint8ClampedArray(64 * 48 * 4).fill(200);
    const capture = RawCapture.from(64, 48, data);
    const region = {
      type: "EMAIL",
      bbox: { x: 4, y: 4, width: 16, height: 8 },
      confidence: 0.85,
      severity: "medium",
      source: "text",
      sources: ["text"],
      evidence: [],
      image: { width: 64, height: 48 },
      normalized: { x: 0, y: 0, width: 0, height: 0 },
    } as SensitiveRegion;
    const { image } = sanitizeImage(capture, [region]);
    const meta = buildVisionMetadata({
      modelId: "yolos-tiny",
      backend: "cpu",
      inferenceLatencyMs: 10,
      detections: 0,
      captureWidth: 64,
      captureHeight: 48,
    });
    const payload = buildVisualPayload({ goal: "g" }, image, image.manifest, meta);
    expect(Object.keys(payload).sort()).toEqual(["redaction_manifest", "task", "vision_metadata", "visual_context"]);
    expect(Object.keys(payload.visual_context).sort()).toEqual(["height", "image", "width"]);
    expect(Object.keys(payload.redaction_manifest).sort()).toEqual(["regions", "version"]);
    expect(Object.keys(payload.vision_metadata).sort()).toEqual([
      "backend",
      "capture_height",
      "capture_width",
      "detections",
      "inference_latency_ms",
      "model",
      "model_version",
      "runtime",
    ]);
    image.dispose();
    capture.dispose();
  });

  it("response keys match the backend VisionStepResponse shape", () => {
    const body = {
      actions: [],
      reason: "Submit application button was not identified",
      completion: false,
      status: "target_not_found",
      model: "gemini-2.0-flash",
      redacted_regions: 2,
    };
    const v = validateVisionStepResponse(body);
    expect(v.ok).toBe(true);
    expect(Object.keys(v.response!).sort()).toEqual(["actions", "completion", "model", "reason", "redacted_regions", "status"]);
  });

  it("visual action types are a subset of the executor action vocabulary", () => {
    expect(ALL_ACTION_NAMES).toContain("click");
  });

  it("status enums agree on both sides of the wire", () => {
    const backend = ["success", "target_not_found", "blocked_by_privacy", "low_confidence", "invalid_model_output", "error"];
    for (const status of backend) {
      const v = validateVisionStepResponse({ actions: [], reason: "r", completion: false, status, model: "", redacted_regions: 0 });
      expect(v.ok, status).toBe(true);
    }
  });

  it("normalized coordinates mean pixel/dimension on both sides", () => {
    const body = {
      actions: [
        {
          type: "click",
          target: {
            bbox: { x: 760, y: 570, width: 165, height: 84 },
            normalized: { x: 760 / 1280, y: 570 / 720, width: 165 / 1280, height: 84 / 720 },
            point: { x: 842, y: 612 },
          },
          confidence: 0.94,
        },
      ],
      reason: "Submit application button",
      completion: false,
      status: "success",
      model: "m",
      redacted_regions: 0,
    };
    expect(validateVisionStepResponse(body).ok).toBe(true);
  });
});
