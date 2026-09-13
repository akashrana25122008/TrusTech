/* ------------------------------------------------------------------ *
 * Image transmission gate — the ONE authoritative outbound image path.
 *
 *   sendSanitized(SanitizedImage) → ALLOW + POST   (only this)
 *   anything else                 → BLOCK, no fetch (always this)
 *
 * Fail-closed checklist, enforced in code (not comments):
 *   1. input must be a live, module-sealed SanitizedImage
 *      (instanceof + seal registry + not disposed) — raw ImageBitmap /
 *      Blob / ArrayBuffer / base64 / data-URL / plain object → BLOCK
 *      WITHOUT touching the network.
 *   2. manifest must be present and validate (version, ids, types,
 *      methods, bbox ranges, duplicates, counts).
 *   3. pixel verification on the artifact must be ok.
 *   4. the presented manifest must deep-equal the sealed manifest
 *      (substitution → BLOCK).
 *   5. POST sanitized PNG + manifest; non-2xx / transport error → BLOCK
 *      (reported, never retried with raw).
 *
 * There is deliberately no `sendRaw()` escape hatch on this class.
 * ------------------------------------------------------------------ */

import {
  isSealedSanitizedImage,
  SanitizedImage,
} from "./sanitized-image";
import {
  REDACTION_MANIFEST_VERSION,
  manifestsEqual,
  validateRedactionManifest,
  type RedactionManifest,
} from "./redaction-manifest";
import { pngDataUrl } from "./png";

export type GateVerdict = "ALLOW" | "BLOCK";

export type GateBlockCode =
  | "NOT_SANITIZED_ARTIFACT"
  | "DISPOSED_ARTIFACT"
  | "MISSING_MANIFEST"
  | "INVALID_MANIFEST"
  | "UNVERIFIED_IMAGE"
  | "MANIFEST_MISMATCH"
  | "UPSTREAM_REJECTED"
  | "TRANSPORT_ERROR";

export interface GateResult {
  verdict: GateVerdict;
  /** Machine-readable block code (present on BLOCK). */
  code?: GateBlockCode;
  /** Value-free human summary (safe to log). */
  reason: string;
  /** True only when bytes actually left on the wire. */
  transmitted: boolean;
  bytesSent: number;
  regionCount: number;
  manifestVersion: string;
  gateMs: number;
}

export interface ImageGateOptions {
  /** Backend base URL, e.g. "http://localhost:8000". */
  baseUrl?: string;
  /** Injectable fetch for tests. */
  fetchFn?: typeof fetch;
  /** Server path for the sanitized-image protocol. */
  endpoint?: string;
}

export const IMAGE_PROTOCOL_ENDPOINT = "/api/agent/vision";

export interface SanitizedImagePayload {
  image: string;
  manifest: RedactionManifest;
}

/**
 * Build the server-facing payload WITHOUT sending (lets tests assert
 * the wire format; the gate is the only caller in production).
 */
export function buildImagePayload(image: SanitizedImage): SanitizedImagePayload {
  return { image: pngDataUrl(image.pngBytes()), manifest: image.manifest };
}

export class ImageTransmissionGate {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly endpoint: string;

  constructor(options: ImageGateOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "http://localhost:8000").replace(/\/+$/, "");
    this.fetchFn = options.fetchFn ?? ((...args) => globalThis.fetch(...args));
    this.endpoint = options.endpoint ?? IMAGE_PROTOCOL_ENDPOINT;
  }

  /**
   * Authorize + transmit ONE sanitized image. Never throws; BLOCK on
   * every failure path. The network is touched ONLY after all local
   * checks pass (AT-03 asserts this with a fetch spy).
   */
  async sendSanitized(image: unknown, presentedManifest?: unknown): Promise<GateResult> {
    const t0 = performance.now();
    const block = (code: GateBlockCode, reason: string): GateResult => ({
      verdict: "BLOCK",
      code,
      reason,
      transmitted: false,
      bytesSent: 0,
      regionCount: 0,
      manifestVersion: REDACTION_MANIFEST_VERSION,
      gateMs: Math.round((performance.now() - t0) * 100) / 100,
    });

    // 1 — artifact authenticity (type + seal + liveness).
    if (!(image instanceof SanitizedImage)) {
      return block("NOT_SANITIZED_ARTIFACT", `rejected ${describeValue(image)}: not a SanitizedImage`);
    }
    if (image.disposed) return block("DISPOSED_ARTIFACT", "rejected disposed SanitizedImage");
    if (!isSealedSanitizedImage(image)) {
      return block("NOT_SANITIZED_ARTIFACT", "rejected unsealed SanitizedImage (not pipeline-produced)");
    }

    // 2 — manifest presence + validity.
    const manifest = (presentedManifest ?? image.manifest) as RedactionManifest;
    if (manifest === null || manifest === undefined) return block("MISSING_MANIFEST", "no redaction manifest");
    if (typeof manifest !== "object") return block("INVALID_MANIFEST", "manifest must be an object");
    const validity = validateRedactionManifest(manifest, { width: image.width, height: image.height });
    if (!validity.ok) {
      return block("INVALID_MANIFEST", `manifest invalid: ${validity.errors[0]}`);
    }

    // 3 — pixel verification must have passed inside the pipeline.
    if (!image.verification || image.verification.ok !== true) {
      return block("UNVERIFIED_IMAGE", "pixel verification did not pass");
    }

    // 4 — presented manifest must equal the sealed manifest.
    if (!manifestsEqual(manifest, image.manifest)) {
      return block("MANIFEST_MISMATCH", "presented manifest differs from sealed manifest");
    }

    // 5 — transmit sanitized PNG + manifest. Any failure → BLOCK.
    let payload: SanitizedImagePayload;
    try {
      payload = buildImagePayload(image);
    } catch (err) {
      return block("TRANSPORT_ERROR", `payload build failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const body = JSON.stringify(payload);
    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}${this.endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body,
      });
    } catch (err) {
      return block("TRANSPORT_ERROR", `transport failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!response.ok) {
      return block("UPSTREAM_REJECTED", `server rejected with HTTP ${response.status}`);
    }

    return {
      verdict: "ALLOW",
      reason: `transmitted sanitized ${image.width}x${image.height} + manifest v${manifest.version} (${manifest.regions.length} regions)`,
      transmitted: true,
      bytesSent: body.length,
      regionCount: manifest.regions.length,
      manifestVersion: manifest.version,
      gateMs: Math.round((performance.now() - t0) * 100) / 100,
    };
  }
}

/** Value-free type description for block reasons (safe to log). */
function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") {
    return value.startsWith("data:image/") ? "string(data-url-image)" : `string(len=${value.length})`;
  }
  if (typeof value === "object") {
    const tag = Object.prototype.toString.call(value);
    if (tag === "[object ArrayBuffer]") return "ArrayBuffer";
    return tag.replace("[object ", "").replace("]", "") || "object";
  }
  return typeof value;
}
