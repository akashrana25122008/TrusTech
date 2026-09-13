import { transmitVisualContext, type VisualTransport } from "@/privacy/visual-transmission";
import type { TransmissionPermit } from "@/privacy/transmission-permit";
import type { SanitizedImage } from "@/privacy/sanitized-image";
import type { RedactionManifest } from "@/privacy/redaction-manifest";
import type { VisionMetadata } from "@/privacy/vision-metadata";
import { validateVisionStepResponse, type VisionStepResponse } from "./vision-step-response";

export const VISION_STEP_ENDPOINT = "/vision_step";

export interface VisionStepTask {
  goal: string;
  intent?: string;
  subtask?: string;
}

export interface VisionStepResult {
  ok: boolean;
  validated?: VisionStepResponse;
  transmitVerdict?: "ALLOW" | "BLOCK";
  code?: string;
  reason: string;
  requestCount: number;
}

export interface VisionStepClientOptions {
  permit: unknown;
  image: unknown;
  manifest?: unknown;
  metadata: unknown;
  task: VisionStepTask;
  transport?: VisualTransport;
  baseUrl?: string;
  allowInsecureLocalhost?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function requestVisionGrounding(options: VisionStepClientOptions): Promise<VisionStepResult> {
  let responseBody: string | undefined;
  const capturing: VisualTransport = {
    async post(url, body, init) {
      const transport = options.transport;
      if (!transport) throw new Error("no transport");
      const res = await transport.post(url, body, init);
      responseBody = res.body;
      return res;
    },
  };
  const tx = await transmitVisualContext({
    permit: options.permit as TransmissionPermit,
    image: options.image as SanitizedImage,
    manifest: options.manifest as RedactionManifest | undefined,
    metadata: options.metadata as VisionMetadata,
    task: options.task,
    transport: options.transport ? capturing : undefined,
    baseUrl: options.baseUrl,
    endpoint: VISION_STEP_ENDPOINT,
    allowInsecureLocalhost: options.allowInsecureLocalhost,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
  if (tx.verdict === "BLOCK" || !tx.transmitted) {
    return {
      ok: false,
      transmitVerdict: "BLOCK",
      code: tx.code,
      reason: tx.reason,
      requestCount: tx.requestCount,
    };
  }
  if (responseBody === undefined) {
    return { ok: false, transmitVerdict: "ALLOW", code: "TRANSPORT_ERROR", reason: "no response body", requestCount: tx.requestCount };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseBody);
  } catch {
    return { ok: false, transmitVerdict: "ALLOW", code: "TRANSPORT_ERROR", reason: "response is not JSON", requestCount: tx.requestCount };
  }
  const validated = validateVisionStepResponse(parsed);
  if (!validated.ok) {
    return {
      ok: false,
      transmitVerdict: "ALLOW",
      code: "TRANSPORT_ERROR",
      reason: `invalid vision_step response: ${validated.errors[0]}`,
      requestCount: tx.requestCount,
    };
  }
  return { ok: true, validated: validated.response, transmitVerdict: "ALLOW", reason: tx.reason, requestCount: tx.requestCount };
}
