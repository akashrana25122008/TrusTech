import type { BrowserAdapter } from "@/browser";
import type { ObservationSnapshot, IndexedElement } from "@/shared/messages";
import type { AgentAction } from "@/shared/action-schema";
import type { TaskGoal } from "./types";
import type { ActionPlanner, PlannerContext } from "./llm-planner";
import type { PlannerAction } from "./deterministic-planner";
import type { VisionRaster, VisionDetection, VisionBackend } from "@/vision/types";
import type { DomPrivacyScan } from "@/privacy/dom-scanner";
import { analyzePrivacy } from "@/privacy/privacy-analyzer";
import { authorizeVisualTransmission } from "@/privacy/transmission-permit";
import { RawCapture, sanitizeImage, type SanitizedImage } from "@/privacy/sanitized-image";
import { buildVisionMetadata, type VisionMetadata } from "@/privacy/vision-metadata";
import { requestVisionGrounding } from "@/vision/vision-step-client";
import { imagePointToViewport } from "@/vision/vision-step-response";
import { captureActiveTab } from "@/vision/capture";
import { VisionWorkerClient } from "@/vision/vision-worker-client";
import { fetchTransport, type VisualTransport } from "@/privacy/visual-transmission";

export interface VisualCapture {
  raster: VisionRaster;
  sourceWidth: number;
  sourceHeight: number;
  captureMs: number;
}

export interface VisualInference {
  detections: VisionDetection[];
  totalMs: number;
  modelId: string;
  backend: VisionBackend;
}

export interface VisualPlannerEvent {
  stage: "grounded" | "fallback";
  regions: number;
  methods: string[];
  detections: number;
  transmitted: boolean;
  latencyMs: number;
  reason?: string;
}

export interface VisualPlannerDeps {
  adapter: Pick<BrowserAdapter, "sendToTabAndRespond">;
  capture: () => Promise<VisualCapture>;
  infer: (raster: VisionRaster) => Promise<VisualInference>;
  transport: VisualTransport;
  baseUrl: string;
  allowInsecureLocalhost?: boolean;
  timeoutMs?: number;
  onEvent?: (event: VisualPlannerEvent) => void;
}

export function correlatePointToElement(
  snapshot: ObservationSnapshot,
  point: { x: number; y: number },
): IndexedElement | null {
  let best: IndexedElement | null = null;
  let bestArea = Number.POSITIVE_INFINITY;
  for (const el of snapshot.elements) {
    if (!el.visible || !el.enabled) continue;
    const r = el.rect;
    if (point.x < r.x || point.y < r.y || point.x >= r.x + r.w || point.y >= r.y + r.h) continue;
    const area = r.w * r.h;
    if (area < bestArea) {
      bestArea = area;
      best = el;
    }
  }
  return best;
}

async function readDomScan(adapter: VisualPlannerDeps["adapter"], tabId: number): Promise<DomPrivacyScan | null> {
  try {
    const reply = (await adapter.sendToTabAndRespond(tabId, { type: "CTX_PRIVACY_SCAN" })) as {
      payload?: DomPrivacyScan;
    };
    const scan = reply?.payload;
    if (!scan || !Array.isArray(scan.signals)) return null;
    return scan;
  } catch {
    return null;
  }
}

export interface VisualRuntimeOptions {
  baseUrl: string;
  authToken?: string;
  timeoutMs?: number;
}

function isLoopbackUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

let sharedWorker: VisionWorkerClient | null = null;

function worker(): VisionWorkerClient {
  if (!sharedWorker) sharedWorker = new VisionWorkerClient({ backend: "auto" });
  return sharedWorker;
}

export function createVisualPlannerDeps(
  adapter: Pick<BrowserAdapter, "sendToTabAndRespond">,
  options: VisualRuntimeOptions,
  overrides: Partial<VisualPlannerDeps> = {},
): VisualPlannerDeps {
  const inner = fetchTransport();
  const transport: VisualTransport = options.authToken
    ? {
        async post(url, body, init) {
          return inner.post(url, body, {
            headers: { ...init.headers, Authorization: `Bearer ${options.authToken}` },
            signal: init.signal,
          });
        },
      }
    : inner;
  return {
    adapter,
    capture: async () => {
      const captured = await captureActiveTab(720);
      return {
        raster: captured.raster,
        sourceWidth: captured.sourceWidth,
        sourceHeight: captured.sourceHeight,
        captureMs: captured.captureMs,
      };
    },
    infer: async (raster) => {
      const client = worker();
      const info = await client.init();
      const result = await client.infer({
        width: raster.width,
        height: raster.height,
        data: raster.data,
        sourceWidth: raster.width,
        sourceHeight: raster.height,
      });
      return {
        detections: result.detections,
        totalMs: result.metrics.totalMs,
        modelId: info.modelId,
        backend: info.backend,
      };
    },
    transport,
    baseUrl: options.baseUrl,
    allowInsecureLocalhost: isLoopbackUrl(options.baseUrl),
    timeoutMs: options.timeoutMs,
    ...overrides,
  };
}

export function buildVisualPlanner(fallback: ActionPlanner, deps: VisualPlannerDeps): ActionPlanner {
  return async (
    goal: TaskGoal,
    stepIndex: number,
    snapshot: ObservationSnapshot,
    context?: PlannerContext,
  ): Promise<PlannerAction | null> => {
    const t0 = performance.now();
    const emit = (event: Omit<VisualPlannerEvent, "latencyMs">) => {
      deps.onEvent?.({ ...event, latencyMs: Math.round((performance.now() - t0) * 100) / 100 });
    };
    const fallthrough = (reason: string): Promise<PlannerAction | null> => {
      emit({ stage: "fallback", regions: 0, methods: [], detections: 0, transmitted: false, reason });
      return Promise.resolve(fallback(goal, stepIndex, snapshot, context));
    };
    try {
      const captured = await deps.capture();
      const pixels = new Uint8ClampedArray(captured.raster.data);
      const inference = await deps.infer(captured.raster);
      const domScan = await readDomScan(deps.adapter, snapshot.tabId);
      const analysis = await analyzePrivacy({
        image: { width: captured.sourceWidth, height: captured.sourceHeight },
        viewport: { width: snapshot.viewport.w, height: snapshot.viewport.h },
        dom: domScan,
        visionDetections: inference.detections,
        visionMs: inference.totalMs,
        captureMs: captured.captureMs,
      });
      const raw = RawCapture.from(captured.raster.width, captured.raster.height, pixels);
      const sx = captured.sourceWidth > 0 ? captured.raster.width / captured.sourceWidth : 1;
      const sy = captured.sourceHeight > 0 ? captured.raster.height / captured.sourceHeight : 1;
      const scaled = analysis.regions.map((r) => ({
        ...r,
        bbox: { x: r.bbox.x * sx, y: r.bbox.y * sy, width: r.bbox.width * sx, height: r.bbox.height * sy },
        image: { width: captured.raster.width, height: captured.raster.height },
      }));
      let image: SanitizedImage;
      try {
        image = sanitizeImage(raw, scaled).image;
      } finally {
        raw.dispose();
      }
      const metadata: VisionMetadata = buildVisionMetadata({
        modelId: inference.modelId,
        backend: inference.backend,
        inferenceLatencyMs: inference.totalMs,
        detections: inference.detections.length,
        captureWidth: captured.sourceWidth,
        captureHeight: captured.sourceHeight,
      });
      const permit = await authorizeVisualTransmission({ image, metadata });
      if (!permit.ok || !permit.permit) {
        image.dispose();
        return fallthrough(`permit refused: ${permit.reason}`);
      }
      const grounded = await requestVisionGrounding({
        permit: permit.permit,
        image,
        metadata,
        task: { goal: goal.goal, intent: goal.intent },
        transport: deps.transport,
        baseUrl: deps.baseUrl,
        allowInsecureLocalhost: deps.allowInsecureLocalhost,
        timeoutMs: deps.timeoutMs,
      });
      const methods = [...new Set(image.manifest.regions.map((r) => r.method))];
      const regionCount = image.manifest.regions.length;
      image.dispose();
      if (!grounded.ok || !grounded.validated || grounded.validated.actions.length === 0) {
        return fallthrough(`vision grounding unavailable: ${grounded.reason}`);
      }
      const proposal = grounded.validated.actions[0];
      if (proposal.type !== "click") return fallthrough("unsupported visual action");
      const viewportPoint = imagePointToViewport(
        proposal.target.point,
        { width: captured.sourceWidth, height: captured.sourceHeight },
        { width: snapshot.viewport.w, height: snapshot.viewport.h },
      );
      if (!viewportPoint) return fallthrough("vision point outside viewport");
      const element = correlatePointToElement(snapshot, viewportPoint);
      if (!element) return fallthrough("vision target has no DOM counterpart");
      const action: AgentAction = {
        action: "click",
        target: { elementId: element.id },
        confidence: proposal.confidence,
      };
      emit({
        stage: "grounded",
        regions: regionCount,
        methods,
        detections: inference.detections.length,
        transmitted: true,
      });
      return {
        action,
        justification: `visual grounding: ${grounded.validated.reason} → ${element.role} "${element.name}"`,
      };
    } catch (err) {
      return fallthrough(err instanceof Error ? err.message : String(err));
    }
  };
}
