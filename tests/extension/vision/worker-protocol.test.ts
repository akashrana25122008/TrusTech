import { describe, it, expect, vi, afterEach } from "vitest";
import { VisionWorkerClient } from "@/vision/vision-worker-client";
import type { VisionWorkerRequest, VisionWorkerResponse } from "@/vision/types";

/**
 * Vision worker protocol — request/response contract, tested with the REAL
 * client code path and a faithful fake Worker host. The client constructs
 * `new Worker(new URL(...))` exactly as the panel does; the stub returns a
 * scripted worker that routes structured messages. We assert the typed
 * request/response payloads that the panel and worker actually exchange.
 */
class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent<VisionWorkerResponse>) => void) | null = null;
  sent: VisionWorkerRequest[] = [];
  terminated = false;
  private queue: VisionWorkerResponse[] = [];

  constructor() {
    FakeWorker.instances.push(this);
  }

  postMessage(message: unknown): void {
    this.sent.push(message as VisionWorkerRequest);
  }

  terminate(): void {
    this.terminated = true;
    this.onmessage = null;
  }

  respond(message: VisionWorkerResponse): void {
    this.queue.push(message);
  }

  flush(): void {
    while (this.queue.length > 0 && this.onmessage) {
      const message = this.queue.shift()!;
      this.onmessage({ data: message } as MessageEvent<VisionWorkerResponse>);
    }
  }
}

vi.stubGlobal("Worker", FakeWorker);

function lastWorker(): FakeWorker {
  return FakeWorker.instances[FakeWorker.instances.length - 1];
}

describe("vision worker client protocol", () => {
  afterEach(() => {
    FakeWorker.instances = [];
  });

  it("INIT → READY round-trip resolves with backend + model + load time", async () => {
    const client = new VisionWorkerClient({ backend: "cpu" });
    const readyP = client.init();
    const worker = lastWorker();
    worker.respond({ kind: "READY", payload: { backend: "cpu", modelId: "yolos-tiny", loadMs: 12.5 } });
    worker.flush();
    const ready = await readyP;
    expect(ready).toEqual({ backend: "cpu", modelId: "yolos-tiny", loadMs: 12.5 });
    const initMsg = worker.sent.find((m) => m.kind === "INIT");
    if (initMsg?.kind === "INIT") {
      expect(initMsg.payload).toMatchObject({ modelId: "yolos-tiny", backend: "cpu", threshold: 0.5, maxDetections: 20 });
    }
    await client.dispose();
  });

  it("INFER resolves with detections keyed by request id, carries source dims", async () => {
    const client = new VisionWorkerClient({ backend: "cpu" });
    const readyP = client.init();
    const worker = lastWorker();
    worker.respond({ kind: "READY", payload: { backend: "cpu", modelId: "yolos-tiny", loadMs: 5 } });
    worker.flush();
    await readyP;
    const inferP = client.infer({
      width: 960,
      height: 540,
      data: new Uint8ClampedArray(960 * 540 * 4),
      sourceWidth: 1920,
      sourceHeight: 1080,
    });
    // Give the infer() microtask continuation a chance to post the message
    await new Promise((r) => setTimeout(r, 0));
    const inferMsg = worker.sent.find((m) => m.kind === "INFER");
    expect(inferMsg).toBeDefined();
    if (inferMsg?.kind !== "INFER") throw new Error("no INFER sent");
    const id = inferMsg.payload.id;
    expect(id).toMatch(/^inf_/);
    worker.respond({
      kind: "INFER_RESULT",
      payload: {
        id,
        detections: [{ type: "face", bbox: { x: 1, y: 2, width: 10, height: 20 }, confidence: 0.98, label: "person" }],
        metrics: { backend: "cpu", loadMs: 0, captureMs: 0, preprocessMs: 2, inferenceMs: 100, postprocessMs: 1, totalMs: 103 },
        sourceWidth: 1920,
        sourceHeight: 1080,
      },
    });
    worker.flush();
    const result = await inferP;
    expect(result.detections[0].label).toBe("person");
    expect(result.metrics.inferenceMs).toBe(100);
    expect(inferMsg.payload.sourceWidth).toBe(1920);
    await client.dispose();
  });

  it("DISPOSE terminates the worker", async () => {
    const client = new VisionWorkerClient({ backend: "cpu" });
    const readyP = client.init();
    const worker = lastWorker();
    worker.respond({ kind: "READY", payload: { backend: "cpu", modelId: "yolos-tiny", loadMs: 1 } });
    worker.flush();
    await readyP;
    await client.dispose();
    expect(worker.terminated).toBe(true);
  });

  it("surfaces worker ERROR as a rejected init", async () => {
    const client = new VisionWorkerClient({ backend: "cpu" });
    const readyP = client.init();
    const worker = lastWorker();
    worker.respond({ kind: "ERROR", payload: { code: "MODEL_LOAD", message: "local model missing" } });
    worker.flush();
    await expect(readyP).rejects.toThrow(/MODEL_LOAD/);
    expect(worker.terminated).toBe(true);
    expect(client.eager).toBe(false);
  });
});