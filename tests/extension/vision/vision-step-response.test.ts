import { describe, it, expect } from "vitest";
import {
  imagePointToViewport,
  validateVisionStepResponse,
  visionActionToAgentAction,
} from "@/vision/vision-step-response";

const SUCCESS = {
  actions: [
    {
      type: "click",
      target: {
        bbox: { x: 760, y: 570, width: 165, height: 84 },
        normalized: { x: 0.594, y: 0.792, width: 0.129, height: 0.117 },
        point: { x: 842, y: 612 },
      },
      confidence: 0.94,
    },
  ],
  reason: "Submit application button",
  completion: false,
  status: "success",
  model: "gemini-2.0-flash",
  redacted_regions: 1,
} as const;

describe("vision-step-response.ts", () => {
  it("accepts the canonical success shape", () => {
    const v = validateVisionStepResponse(SUCCESS);
    expect(v.ok).toBe(true);
    expect(v.response!.actions).toHaveLength(1);
    expect(v.response!.actions[0].target.point).toEqual({ x: 842, y: 612 });
  });

  it("accepts every documented status with empty actions", () => {
    for (const status of ["success", "target_not_found", "blocked_by_privacy", "low_confidence", "invalid_model_output", "error"]) {
      const v = validateVisionStepResponse({ actions: [], reason: "r", completion: false, status, model: "", redacted_regions: 0 });
      expect(v.ok, status).toBe(true);
      expect(v.response!.status).toBe(status);
    }
  });

  it("rejects unknown actions, bad confidence, point-outside-bbox", () => {
    const badType = { ...SUCCESS, actions: [{ ...SUCCESS.actions[0], type: "type" }] };
    expect(validateVisionStepResponse(badType).ok).toBe(false);
    const badConf = { ...SUCCESS, actions: [{ ...SUCCESS.actions[0], confidence: 1.5 }] };
    expect(validateVisionStepResponse(badConf).ok).toBe(false);
    const badPoint = {
      ...SUCCESS,
      actions: [{ ...SUCCESS.actions[0], target: { ...SUCCESS.actions[0].target, point: { x: 10, y: 10 } } }],
    };
    expect(validateVisionStepResponse(badPoint).ok).toBe(false);
    expect(validateVisionStepResponse(null).ok).toBe(false);
    expect(validateVisionStepResponse({ ...SUCCESS, status: "maybe" }).ok).toBe(false);
  });

  it("rejects out-of-range normalized boxes", () => {
    const bad = {
      ...SUCCESS,
      actions: [{ ...SUCCESS.actions[0], target: { ...SUCCESS.actions[0].target, normalized: { x: 1.5, y: 0, width: 0.1, height: 0.1 } } }],
    };
    expect(validateVisionStepResponse(bad).ok).toBe(false);
  });

  it("imagePointToViewport scales deterministically", () => {
    expect(imagePointToViewport({ x: 842, y: 612 }, { width: 1280, height: 720 }, { width: 1280, height: 720 })).toEqual({ x: 842, y: 612 });
    expect(imagePointToViewport({ x: 640, y: 360 }, { width: 1280, height: 720 }, { width: 640, height: 360 })).toEqual({ x: 320, y: 180 });
    expect(imagePointToViewport({ x: -1, y: 0 }, { width: 100, height: 100 }, { width: 100, height: 100 })).toBeNull();
    expect(imagePointToViewport({ x: 100, y: 0 }, { width: 100, height: 100 }, { width: 100, height: 100 })).toBeNull();
    expect(imagePointToViewport({ x: 0, y: 0 }, { width: 0, height: 100 }, { width: 100, height: 100 })).toBeNull();
  });

  it("visionActionToAgentAction yields an executor-ready click", () => {
    const a = visionActionToAgentAction(SUCCESS.actions[0]);
    expect(a.action).toBe("click");
    expect(a.confidence).toBe(0.94);
  });
});
