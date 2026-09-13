/// <reference lib="webworker" />
import { VisionEngine } from "./vision-engine";
import type { VisionWorkerRequest, VisionWorkerResponse } from "../types";

declare const self: DedicatedWorkerGlobalScope;

let engine: VisionEngine | null = null;

function send(message: VisionWorkerResponse): void {
  self.postMessage(message);
}

self.onmessage = async (event: MessageEvent<VisionWorkerRequest>) => {
  const request = event.data;
  try {
    switch (request.kind) {
      case "INIT": {
        engine = new VisionEngine();
        const { modelId, backend, loadMs } = await engine.init({
          backend: request.payload.backend === "auto" ? undefined : request.payload.backend,
        });
        send({ kind: "READY", payload: { backend, modelId, loadMs } });
        return;
      }
      case "INFER": {
        if (!engine) {
          send({ kind: "ERROR", payload: { id: request.payload.id, code: "NOT_INITIALIZED", message: "worker is not initialized" } });
          return;
        }
        const result = await engine.infer({
          id: request.payload.id,
          width: request.payload.width,
          height: request.payload.height,
          data: new Uint8ClampedArray(request.payload.data),
          sourceWidth: request.payload.sourceWidth,
          sourceHeight: request.payload.sourceHeight,
        });
        send({ kind: "INFER_RESULT", payload: { ...result, id: request.payload.id } });
        return;
      }
      case "DISPOSE": {
        if (engine) await engine.dispose();
        engine = null;
        send({ kind: "DISPOSED" });
        return;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const id = request.kind === "INFER" ? request.payload.id : undefined;
    send({ kind: "ERROR", payload: { id, code: "WORKER_ERROR", message } });
  }
};