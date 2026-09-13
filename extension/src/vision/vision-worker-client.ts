import type {
  VisionBackend,
  VisionInferResult,
  VisionInitConfig,
  VisionWorkerRequest,
  VisionWorkerResponse,
} from "./types";

type Listener = (message: VisionWorkerResponse) => void;
type InferResolve = (result: VisionInferResult) => void;

export interface VisionWorkerClientOptions {
  backend?: VisionBackend | "auto";
  modelId?: string;
  threshold?: number;
  maxDetections?: number;
}

export class VisionWorkerClient {
  private worker: Worker | null = null;
  private current: Promise<{ backend: VisionBackend; modelId: string; loadMs: number }> | null = null;
  private listeners = new Set<Listener>();
  private pending = new Map<string, InferResolve>();

  constructor(private readonly options: VisionWorkerClientOptions = {}) {}

  async init(): Promise<{ backend: VisionBackend; modelId: string; loadMs: number }> {
    if (this.current) return this.current;
    this.current = new Promise<{ backend: VisionBackend; modelId: string; loadMs: number }>((resolve, reject) => {
      try {
        this.worker = new Worker(new URL("./worker/vision.worker.ts", import.meta.url), { type: "module" });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      this.worker.onmessage = (event: MessageEvent<VisionWorkerResponse>) => this.dispatch(event.data);
      this.worker.onerror = (err) => {
        const payload = {
          kind: "ERROR" as const,
          payload: { code: "WORKER_CRASH", message: err?.message ?? "vision worker crashed" },
        };
        this.dispatch(payload);
      };
      const waiter: Listener = (message) => {
        if (message.kind === "READY") {
          this.listeners.delete(waiter);
          resolve(message.payload);
        } else if (message.kind === "ERROR") {
          this.listeners.delete(waiter);
          this.current = null;
          if (this.worker) {
            this.worker.terminate();
            this.worker.onmessage = null;
            this.worker = null;
          }
          reject(new Error(`[${message.payload.code}] ${message.payload.message}`));
        }
      };
      this.listeners.add(waiter);
      const cfg: VisionInitConfig = {
        modelId: this.options.modelId ?? "yolos-tiny",
        backend: this.options.backend ?? "auto",
        threshold: this.options.threshold ?? 0.5,
        maxDetections: this.options.maxDetections ?? 20,
      };
      this.post({ kind: "INIT", payload: cfg });
    });
    return this.current;
  }

  async infer(raster: {
    width: number;
    height: number;
    data: Uint8ClampedArray;
    sourceWidth: number;
    sourceHeight: number;
  }): Promise<VisionInferResult> {
    await this.init();
    const worker = this.worker;
    if (!worker) throw new Error("vision worker is not running");
    const id = `inf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const promise = new Promise<VisionInferResult>((resolve, reject) => {
      const guard = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("inference timed out after 5 minutes"));
      }, 300_000);
      this.pending.set(id, (result) => {
        clearTimeout(guard);
        resolve(result);
      });
    });
    const buffer = raster.data.buffer.slice(raster.data.byteOffset, raster.data.byteOffset + raster.data.byteLength) as ArrayBuffer;
    this.post(
      {
        kind: "INFER",
        payload: {
          id,
          width: raster.width,
          height: raster.height,
          data: buffer,
          sourceWidth: raster.sourceWidth,
          sourceHeight: raster.sourceHeight,
        },
      } satisfies VisionWorkerRequest,
      [buffer],
    );
    return promise;
  }

  onMessage(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async dispose(): Promise<void> {
    this.listeners.clear();
    if (this.worker) {
      this.post({ kind: "DISPOSE" });
      this.worker.terminate();
      this.worker = null;
    }
    this.current = null;
    for (const reject of this.pending.values()) reject({ id: "", detections: [], metrics: {} as never, sourceWidth: 0, sourceHeight: 0 });
    this.pending.clear();
  }

  get eager(): boolean {
    return this.current !== null;
  }

  private dispatch(message: VisionWorkerResponse): void {
    if (message.kind === "INFER_RESULT") {
      const resolver = this.pending.get(message.payload.id);
      if (resolver) {
        this.pending.delete(message.payload.id);
        resolver(message.payload);
      }
    }
    for (const listener of [...this.listeners]) listener(message);
  }

  private post(message: VisionWorkerRequest, transfer?: Transferable[]): void {
    if (!this.worker) throw new Error("vision worker is not running");
    this.worker.postMessage(message, transfer ?? []);
  }
}