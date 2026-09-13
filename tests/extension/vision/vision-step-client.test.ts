import { describe, it, expect } from "vitest";
import { requestVisionGrounding } from "@/vision/vision-step-client";
import { runVisionStepLoop } from "@/vision/vision-step-loop";
import { authorizeVisualTransmission } from "@/privacy/transmission-permit";
import { RawCapture, sanitizeImage } from "@/privacy/sanitized-image";
import { buildVisionMetadata } from "@/privacy/vision-metadata";
import type { VisualTransport } from "@/privacy/visual-transmission";
import type { SensitiveRegion } from "@/privacy/regions";

function region(): SensitiveRegion {
  return {
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
}

function raw() {
  const data = new Uint8ClampedArray(64 * 48 * 4);
  for (let i = 0; i < data.length; i++) data[i] = (i * 3) % 256;
  return RawCapture.from(64, 48, data);
}

function metadata() {
  return buildVisionMetadata({
    modelId: "yolos-tiny",
    backend: "cpu",
    inferenceLatencyMs: 40,
    detections: 1,
    captureWidth: 64,
    captureHeight: 48,
  });
}

const SUCCESS_BODY = JSON.stringify({
  actions: [
    {
      type: "click",
      target: {
        bbox: { x: 10, y: 10, width: 20, height: 10 },
        normalized: { x: 0.1563, y: 0.2083, width: 0.3125, height: 0.2083 },
        point: { x: 20, y: 15 },
      },
      confidence: 0.94,
    },
  ],
  reason: "Submit application button",
  completion: false,
  status: "success",
  model: "gemini-2.0-flash",
  redacted_regions: 1,
});

function transportWithBodies(bodies: string[], payload = SUCCESS_BODY): VisualTransport {
  return {
    async post(_url: string, body: string) {
      bodies.push(body);
      return { ok: true, status: 200, body: payload };
    },
  };
}

async function authorized() {
  const r = raw();
  const { image } = sanitizeImage(r, [region()]);
  const meta = metadata();
  const { permit } = await authorizeVisualTransmission({ image, metadata: meta });
  return { r, image, meta, permit: permit! };
}

const TASK = { goal: "Click submit" };
const NET = { baseUrl: "http://localhost:8000", allowInsecureLocalhost: true } as const;

describe("vision-step-client.ts", () => {
  it("transmits to /vision_step and returns the validated response", async () => {
    const { r, image, meta, permit } = await authorized();
    const bodies: string[] = [];
    let url = "";
    const transport: VisualTransport = {
      async post(u: string, body: string) {
        url = u;
        bodies.push(body);
        return { ok: true, status: 200, body: SUCCESS_BODY };
      },
    };
    const res = await requestVisionGrounding({ permit, image, metadata: meta, task: TASK, transport, ...NET });
    expect(res.ok).toBe(true);
    expect(res.requestCount).toBe(1);
    expect(url).toBe("http://localhost:8000/vision_step");
    expect(res.validated!.actions[0].target.point).toEqual({ x: 20, y: 15 });
    const sent = JSON.parse(bodies[0]);
    expect(Object.keys(sent).sort()).toEqual(["redaction_manifest", "task", "vision_metadata", "visual_context"]);
    image.dispose();
    r.dispose();
  });

  it("blocks without a permit and sends nothing", async () => {
    const { r, image, meta } = await authorized();
    const bodies: string[] = [];
    const res = await requestVisionGrounding({
      permit: undefined,
      image,
      metadata: meta,
      task: TASK,
      transport: transportWithBodies(bodies),
      ...NET,
    });
    expect(res.ok).toBe(false);
    expect(res.requestCount).toBe(0);
    expect(bodies).toHaveLength(0);
    image.dispose();
    r.dispose();
  });

  it("rejects non-JSON and schema-invalid bodies without executing anything", async () => {
    const { r, image, meta, permit } = await authorized();
    for (const body of ["nope {", JSON.stringify({ actions: [], reason: "x", completion: false, status: "maybe" })]) {
      const res = await requestVisionGrounding({
        permit,
        image,
        metadata: meta,
        task: TASK,
        transport: transportWithBodies([], body),
        ...NET,
      });
      expect(res.ok).toBe(false);
    }
    image.dispose();
    r.dispose();
  });
});

describe("vision-step-loop.ts", () => {
  it("stops on the first actionable response", async () => {
    const { r, image, meta, permit } = await authorized();
    const out = await runVisionStepLoop({
      permit,
      image,
      metadata: meta,
      task: TASK,
      transport: transportWithBodies([]),
      ...NET,
      maxIterations: 5,
    });
    expect(out.iterations).toBe(1);
    expect(out.last.ok).toBe(true);
    image.dispose();
    r.dispose();
  });

  it("stops after a repeated inconclusive state instead of looping", async () => {
    const { r, image, meta, permit } = await authorized();
    const inconclusive = JSON.stringify({ actions: [], reason: "not seen", completion: false, status: "target_not_found", model: "", redacted_regions: 1 });
    const out = await runVisionStepLoop({
      permit,
      image,
      metadata: meta,
      task: TASK,
      transport: transportWithBodies([], inconclusive),
      ...NET,
      maxIterations: 5,
    });
    expect(out.iterations).toBe(2);
    expect(out.stoppedBy).toBe("target_not_found");
    expect(out.completed).toBe(false);
    image.dispose();
    r.dispose();
  });

  it("caps iterations at maxIterations", async () => {
    const { r, image, meta, permit } = await authorized();
    const alternating = [
      JSON.stringify({ actions: [], reason: "a", completion: false, status: "target_not_found", model: "", redacted_regions: 1 }),
      JSON.stringify({ actions: [], reason: "b", completion: false, status: "low_confidence", model: "", redacted_regions: 1 }),
    ];
    let n = 0;
    const transport: VisualTransport = {
      async post() {
        return { ok: true, status: 200, body: alternating[n++ % 2] };
      },
    };
    const out = await runVisionStepLoop({ permit, image, metadata: meta, task: TASK, transport, ...NET, maxIterations: 2 });
    expect(out.iterations).toBe(2);
    expect(out.stoppedBy).toBe("max_iterations");
    image.dispose();
    r.dispose();
  });
});
