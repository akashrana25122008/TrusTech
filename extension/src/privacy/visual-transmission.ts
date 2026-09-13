/* ------------------------------------------------------------------ *
 * Visual transmission — the ONE authoritative image sender (§3).
 *
 *   transmitVisualContext({ permit, image, metadata, task, … })
 *
 * The sender accepts NO raw shapes (RawCapture / ImageBitmap / Blob /
 * ArrayBuffer / base64 are compile-time strangers and runtime BLOCKs).
 * It requires a live TransmissionPermit bound to the exact bytes being
 * sent, revalidated on EVERY attempt including retries.
 *
 * Wire contract (§4):
 *   { task, visual_context: {image, width, height},
 *     redaction_manifest, vision_metadata }
 *
 * Transport rules (§17): https only, unless explicitly documented local
 * dev (allowInsecureLocalhost + localhost/loopback host only).
 * Retries reuse the same sealed bytes (§19). Queues hold permits, never
 * raw captures (§20). Abort/timeout fail closed (§21). Telemetry is
 * value-free (§25/26).
 * ------------------------------------------------------------------ */

import {
  isSealedSanitizedImage,
  SanitizedImage,
} from "./sanitized-image";
import {
  manifestsEqual,
  validateRedactionManifest,
  type RedactionManifest,
} from "./redaction-manifest";
import { validateVisionMetadata, type VisionMetadata } from "./vision-metadata";
import { isLivePermit, revalidatePermit, type TransmissionPermit } from "./transmission-permit";
import { IMAGE_PROTOCOL_ENDPOINT } from "./image-gate";
import { pngDataUrl } from "./png";

/* ---------------- payload contract (§4) ---------------- */

export interface TaskPayload {
  goal: string;
  intent?: string;
  url?: string;
  tabId?: number;
}

export interface VisualContextPayload {
  /** Sanitized PNG as a data URL. */
  image: string;
  width: number;
  height: number;
}

export interface VisualTransmissionPayload {
  task: TaskPayload;
  visual_context: VisualContextPayload;
  redaction_manifest: RedactionManifest;
  vision_metadata: VisionMetadata;
}

export interface PayloadValidation {
  ok: boolean;
  errors: string[];
}

const MAX_GOAL_CHARS = 2000;
const MAX_DIMENSION = 8192;

export function validateTaskPayload(task: unknown): string[] {
  const errors: string[] = [];
  if (!task || typeof task !== "object" || Array.isArray(task)) return ["task must be an object"];
  const t = task as Record<string, unknown>;
  const allowed = new Set(["goal", "intent", "url", "tabId"]);
  for (const k of Object.keys(t)) if (!allowed.has(k)) errors.push(`task unknown key: ${k}`);
  if (typeof t.goal !== "string" || t.goal.length === 0 || t.goal.length > MAX_GOAL_CHARS) {
    errors.push("task.goal must be a 1..2000 char string");
  }
  if (t.intent !== undefined && (typeof t.intent !== "string" || t.intent.length > 200)) errors.push("task.intent too long");
  if (t.url !== undefined && (typeof t.url !== "string" || t.url.length > 2000)) errors.push("task.url too long");
  if (t.tabId !== undefined && (typeof t.tabId !== "number" || !Number.isInteger(t.tabId))) errors.push("task.tabId must be an integer");
  return errors;
}

export function validateVisualPayload(payload: unknown): PayloadValidation {
  const errors: string[] = [];
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, errors: ["payload must be an object"] };
  }
  const p = payload as Record<string, unknown>;
  for (const k of Object.keys(p)) {
    if (!["task", "visual_context", "redaction_manifest", "vision_metadata"].includes(k)) errors.push(`unknown top-level key: ${k}`);
  }
  errors.push(...validateTaskPayload(p.task));
  const vc = p.visual_context as Record<string, unknown> | undefined;
  if (!vc || typeof vc !== "object") {
    errors.push("visual_context must be an object");
  } else {
    for (const k of Object.keys(vc)) if (!["image", "width", "height"].includes(k)) errors.push(`visual_context unknown key: ${k}`);
    if (typeof vc.image !== "string" || !vc.image.startsWith("data:image/png;base64,")) {
      errors.push("visual_context.image must be a PNG data URL");
    }
    for (const k of ["width", "height"] as const) {
      const v = vc[k];
      if (typeof v !== "number" || !Number.isInteger(v) || v <= 0 || v > MAX_DIMENSION) errors.push(`visual_context.${k} out of range`);
    }
  }
  const mv = validateRedactionManifest(p.redaction_manifest);
  if (!mv.ok) errors.push(`redaction_manifest: ${mv.errors[0]}`);
  const md = validateVisionMetadata(p.vision_metadata);
  if (!md.ok) errors.push(`vision_metadata: ${md.errors[0]}`);
  return { ok: errors.length === 0, errors };
}

export function buildVisualPayload(
  task: TaskPayload,
  image: SanitizedImage,
  manifest: RedactionManifest,
  metadata: VisionMetadata,
): VisualTransmissionPayload {
  return {
    task: { ...task },
    visual_context: { image: pngDataUrl(image.pngBytes()), width: image.width, height: image.height },
    redaction_manifest: manifest,
    vision_metadata: { ...metadata },
  };
}

/* ---------------- transport (§17) ---------------- */

export interface TransportResponse {
  ok: boolean;
  status: number;
  /** Raw response text when the caller must validate it (vision_step).
   *  Never logged; validated immediately by the caller. */
  body?: string;
}

export interface VisualTransport {
  post(url: string, body: string, init: { headers: Record<string, string>; signal?: AbortSignal }): Promise<TransportResponse>;
}

export function fetchTransport(fetchFn: typeof fetch = globalThis.fetch): VisualTransport {
  return {
    async post(url, body, init) {
      const res = await fetchFn(url, { method: "POST", headers: init.headers, body, signal: init.signal });
      let text: string | undefined;
      try {
        text = await res.text();
      } catch {
        text = undefined;
      }
      return { ok: res.ok, status: res.status, body: text };
    },
  };
}

/** Development = explicit opt-in + loopback host only. Everything else
 *  must be https. Production TLS is never weakened for tests (tests use
 *  the mock transport, not http). */
export function assertSecureEndpoint(url: string, allowInsecureLocalhost: boolean): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "endpoint is not a valid URL";
  }
  if (parsed.protocol === "https:") return null;
  if (allowInsecureLocalhost && (parsed.protocol === "http:" || parsed.protocol === "https:")) {
    const host = parsed.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1") return null;
    return "insecure transport only allowed for loopback hosts";
  }
  return "insecure transport rejected (https required)";
}

/* ---------------- telemetry (§25/26, value-free) ---------------- */

export type TelemetryEventType =
  | "TRANSMISSION_ALLOWED"
  | "TRANSMISSION_BLOCKED"
  | "VERIFICATION_FAILED"
  | "MANIFEST_INVALID"
  | "RAW_IMAGE_REJECTED"
  | "PERMIT_ISSUE_FAILED"
  | "UPSTREAM_REJECTED"
  | "TIMEOUT"
  | "ABORTED";

export interface TelemetryEvent {
  type: TelemetryEventType;
  reason: string;
  regions: number;
  permitId?: string;
  latenciesMs?: Record<string, number>;
  at: number;
}

const TELEMETRY: TelemetryEvent[] = [];

export function emitTelemetry(event: Omit<TelemetryEvent, "at">): void {
  TELEMETRY.push({ ...event, at: Date.now() });
  if (TELEMETRY.length > 200) TELEMETRY.splice(0, TELEMETRY.length - 200);
}

export function drainTelemetry(): TelemetryEvent[] {
  return TELEMETRY.splice(0, TELEMETRY.length);
}

/* ---------------- the sender ---------------- */

export type TransmitBlockCode =
  | "NOT_SANITIZED_ARTIFACT"
  | "NO_PERMIT"
  | "PERMIT_INVALID"
  | "MANIFEST_MISMATCH"
  | "INVALID_METADATA"
  | "INVALID_TASK"
  | "PAYLOAD_INVALID"
  | "INSECURE_TRANSPORT"
  | "UPSTREAM_REJECTED"
  | "TRANSPORT_ERROR"
  | "TIMEOUT"
  | "ABORTED";

export interface TransmitResult {
  verdict: "ALLOW" | "BLOCK";
  code?: TransmitBlockCode;
  reason: string;
  transmitted: boolean;
  /** Network requests performed by THIS call (0 on every BLOCK). */
  requestCount: number;
  bytesSent: number;
  regionCount: number;
  attempts: number;
  latenciesMs: { encodeMs: number; gateMs: number; networkMs: number; totalMs: number };
}

export interface TransmitInput {
  permit: unknown;
  image: unknown;
  manifest?: unknown;
  metadata: unknown;
  task: unknown;
  transport?: VisualTransport;
  baseUrl?: string;
  endpoint?: string;
  allowInsecureLocalhost?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  now?: number;
}

export async function transmitVisualContext(input: TransmitInput): Promise<TransmitResult> {
  const t0 = performance.now();
  const lat = { encodeMs: 0, gateMs: 0, networkMs: 0, totalMs: 0 };
  const block = (code: TransmitBlockCode, reason: string, event: TelemetryEventType): TransmitResult => {
    lat.totalMs = Math.round((performance.now() - t0) * 100) / 100;
    emitTelemetry({ type: event, reason, regions: 0, latenciesMs: { ...lat } });
    return {
      verdict: "BLOCK",
      code,
      reason,
      transmitted: false,
      requestCount: 0,
      bytesSent: 0,
      regionCount: 0,
      attempts: 1,
      latenciesMs: { ...lat },
    };
  };

  if (input.signal?.aborted) return block("ABORTED", "aborted before start", "ABORTED");

  // 1 — artifact authenticity (compile-time strangers rejected at runtime).
  const image = input.image;
  if (!(image instanceof SanitizedImage) || image.disposed || !isSealedSanitizedImage(image)) {
    const raw = image === null || image === undefined || typeof image === "string" || typeof image !== "object";
    return block(
      "NOT_SANITIZED_ARTIFACT",
      "not a live sealed SanitizedImage",
      raw ? "RAW_IMAGE_REJECTED" : "TRANSMISSION_BLOCKED",
    );
  }

  // 2 — permit required, live, and revalidated against CURRENT bytes.
  if (!isLivePermit(input.permit)) return block("NO_PERMIT", "no live TransmissionPermit", "TRANSMISSION_BLOCKED");
  const tGate = performance.now();
  const reval = await revalidatePermit({ permit: input.permit, image, manifest: input.manifest, now: input.now });
  lat.gateMs = Math.round((performance.now() - tGate) * 100) / 100;
  if (!reval.ok) {
    const code = reval.code === "MANIFEST_MISMATCH" ? "MANIFEST_MISMATCH" : "PERMIT_INVALID";
    return block(code as TransmitBlockCode, `permit revalidation failed: ${reval.reason}`, "TRANSMISSION_BLOCKED");
  }
  const permit = input.permit as TransmissionPermit;

  // 3 — manifest + metadata + task validation.
  const manifest = (input.manifest ?? image.manifest) as RedactionManifest;
  const mv = validateRedactionManifest(manifest, { width: image.width, height: image.height });
  if (!mv.ok) return block("MANIFEST_MISMATCH", `manifest invalid: ${mv.errors[0]}`, "MANIFEST_INVALID");
  if (!manifestsEqual(manifest, image.manifest)) {
    return block("MANIFEST_MISMATCH", "presented manifest differs from sealed", "MANIFEST_INVALID");
  }
  const md = validateVisionMetadata(input.metadata);
  if (!md.ok) return block("INVALID_METADATA", `metadata invalid: ${md.errors[0]}`, "TRANSMISSION_BLOCKED");
  const taskErrors = validateTaskPayload(input.task);
  if (taskErrors.length > 0) return block("INVALID_TASK", taskErrors[0], "TRANSMISSION_BLOCKED");

  // 4 — endpoint security.
  const baseUrl = (input.baseUrl ?? "http://localhost:8000").replace(/\/+$/, "");
  const url = `${baseUrl}${input.endpoint ?? IMAGE_PROTOCOL_ENDPOINT}`;
  const insecure = assertSecureEndpoint(url, input.allowInsecureLocalhost ?? false);
  if (insecure) return block("INSECURE_TRANSPORT", insecure, "TRANSMISSION_BLOCKED");

  // 5 — encode ONLY the sealed artifact, then validate the final payload.
  const tEncode = performance.now();
  let payload: VisualTransmissionPayload;
  try {
    payload = buildVisualPayload(input.task as TaskPayload, image, manifest, input.metadata as VisionMetadata);
  } catch (err) {
    return block("TRANSPORT_ERROR", `encode failed: ${err instanceof Error ? err.message : String(err)}`, "TRANSMISSION_BLOCKED");
  }
  lat.encodeMs = Math.round((performance.now() - tEncode) * 100) / 100;
  const pv = validateVisualPayload(payload);
  if (!pv.ok) return block("PAYLOAD_INVALID", pv.errors[0], "TRANSMISSION_BLOCKED");
  const body = JSON.stringify(payload);

  // 6 — single POST with timeout/abort. Failures never fall back to raw.
  const transport = input.transport ?? fetchTransport();
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (input.signal) {
    if (input.signal.aborted) return block("ABORTED", "aborted before send", "ABORTED");
    input.signal.addEventListener("abort", onAbort, { once: true });
  }
  const timeout = input.timeoutMs ?? 30_000;
  const timer = setTimeout(onAbort, timeout);
  const tNet = performance.now();
  try {
    const res = await transport.post(url, body, {
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      signal: controller.signal,
    });
    lat.networkMs = Math.round((performance.now() - tNet) * 100) / 100;
    if (input.signal?.aborted) return block("ABORTED", "aborted during send", "ABORTED");
    if (!res.ok) {
      lat.totalMs = Math.round((performance.now() - t0) * 100) / 100;
      emitTelemetry({ type: "UPSTREAM_REJECTED", reason: `HTTP ${res.status}`, regions: manifest.regions.length, permitId: permit.id });
      return {
        verdict: "BLOCK",
        code: "UPSTREAM_REJECTED",
        reason: `server rejected with HTTP ${res.status}`,
        transmitted: false,
        requestCount: 1, // one POST was attempted; nothing usable accepted
        bytesSent: 0,
        regionCount: manifest.regions.length,
        attempts: 1,
        latenciesMs: { ...lat },
      };
    }
    lat.totalMs = Math.round((performance.now() - t0) * 100) / 100;
    emitTelemetry({
      type: "TRANSMISSION_ALLOWED",
      reason: `sent ${image.width}x${image.height} + manifest v${manifest.version}`,
      regions: manifest.regions.length,
      permitId: permit.id,
      latenciesMs: { ...lat },
    });
    return {
      verdict: "ALLOW",
      reason: `transmitted sanitized ${image.width}x${image.height} + manifest v${manifest.version} (${manifest.regions.length} regions)`,
      transmitted: true,
      requestCount: 1,
      bytesSent: body.length,
      regionCount: manifest.regions.length,
      attempts: 1,
      latenciesMs: { ...lat },
    };
  } catch (err) {
    lat.networkMs = Math.round((performance.now() - tNet) * 100) / 100;
    const aborted = input.signal?.aborted || controller.signal.aborted;
    const timeoutHit = aborted && !(input.signal?.aborted);
    if (input.signal?.aborted) return block("ABORTED", "aborted during send", "ABORTED");
    if (timeoutHit) {
      lat.totalMs = Math.round((performance.now() - t0) * 100) / 100;
      emitTelemetry({ type: "TIMEOUT", reason: `timeout after ${timeout}ms`, regions: manifest.regions.length, permitId: permit.id });
      return {
        verdict: "BLOCK",
        code: "TIMEOUT",
        reason: `timeout after ${timeout}ms`,
        transmitted: false,
        requestCount: 0,
        bytesSent: 0,
        regionCount: manifest.regions.length,
        attempts: 1,
        latenciesMs: { ...lat },
      };
    }
    return block(
      "TRANSPORT_ERROR",
      `transport failed: ${err instanceof Error ? err.message : String(err)}`,
      "TRANSMISSION_BLOCKED",
    );
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onAbort);
  }
}

/* ---------------- retry (§19): same bytes, revalidated ---------------- */

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  onAttempt?: (attempt: number, result: TransmitResult) => void;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Retry with the SAME sealed artifact + permit. The permit is
 * revalidated before every attempt (expiry kills the retry loop); the
 * bytes are re-hashed on every attempt (mutation kills it). Pixel
 * regeneration for a retry is impossible through this API.
 */
export async function transmitWithRetry(
  input: Omit<TransmitInput, "signal"> & { signal?: AbortSignal },
  options: RetryOptions = {},
): Promise<TransmitResult> {
  const maxAttempts = Math.max(1, Math.min(5, options.maxAttempts ?? 2));
  const baseDelay = options.baseDelayMs ?? 250;
  const sleep = options.sleep ?? defaultSleep;
  let last: TransmitResult | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // eslint-disable-next-line no-await-in-loop
    const res = await transmitVisualContext(input);
    last = { ...res, attempts: attempt };
    options.onAttempt?.(attempt, last);
    if (res.verdict === "ALLOW") return last;
    // Retryable: transport-level failures only. Privacy verdicts
    // (permit/manifest/metadata/payload) never retry — re-authorize.
    if (res.code !== "TRANSPORT_ERROR" && res.code !== "TIMEOUT" && res.code !== "UPSTREAM_REJECTED") return last;
    if (attempt < maxAttempts) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(baseDelay * attempt);
    }
  }
  return last!;
}

/* ---------------- queue (§20): permits only, never raw) ---------------- */

export interface QueuedVisualItem {
  permit: TransmissionPermit;
  image: SanitizedImage;
  manifest: RedactionManifest;
  metadata: VisionMetadata;
  task: TaskPayload;
}

export type QueueRejectCode = "NOT_SANITIZED_ARTIFACT" | "NO_PERMIT" | "QUEUE_FULL";

export class VisualTransmissionQueue {
  private readonly items: QueuedVisualItem[] = [];
  constructor(private readonly maxItems: number = 10) {}

  /** Enqueue a sealed artifact + live permit. Raw shapes are rejected. */
  enqueue(item: unknown): { accepted: boolean; code?: QueueRejectCode; reason: string } {
    if (this.items.length >= this.maxItems) {
      return { accepted: false, code: "QUEUE_FULL", reason: `queue full (${this.maxItems})` };
    }
    const it = item as Partial<QueuedVisualItem>;
    if (!(it.image instanceof SanitizedImage) || it.image.disposed || !isSealedSanitizedImage(it.image)) {
      return { accepted: false, code: "NOT_SANITIZED_ARTIFACT", reason: "queue rejects non-sealed images" };
    }
    if (!isLivePermit(it.permit)) {
      return { accepted: false, code: "NO_PERMIT", reason: "queue requires a live permit" };
    }
    if (!it.manifest || !it.metadata || !it.task) {
      return { accepted: false, code: "NO_PERMIT", reason: "queue item missing manifest/metadata/task" };
    }
    this.items.push(it as QueuedVisualItem);
    return { accepted: true, reason: `queued (${this.items.length}/${this.maxItems})` };
  }

  get size(): number {
    return this.items.length;
  }

  /**
   * Drain through transmitVisualContext (each item revalidated at send).
   * Items whose artifact/permit died in the queue are reported BLOCKed.
   */
  async drain(
    send: (item: QueuedVisualItem) => Promise<TransmitResult>,
  ): Promise<Array<{ item: QueuedVisualItem; result: TransmitResult }>> {
    const out: Array<{ item: QueuedVisualItem; result: TransmitResult }> = [];
    while (this.items.length > 0) {
      const item = this.items.shift()!;
      // eslint-disable-next-line no-await-in-loop
      out.push({ item, result: await send(item) });
    }
    return out;
  }

  clear(): void {
    this.items.length = 0;
  }
}
