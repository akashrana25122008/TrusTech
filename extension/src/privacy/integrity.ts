/* ------------------------------------------------------------------ *
 * Integrity primitives — bind permits and payloads to exact bytes.
 *
 * sha256Hex uses WebCrypto (browsers, workers, node ≥19). If no
 * SubtleCrypto exists the function THROWS (fail closed) rather than
 * silently downgrading to a weak hash — integrity without a strong
 * hash is theater.
 * ------------------------------------------------------------------ */

export class IntegrityError extends Error {
  constructor(message: string) {
    super(`integrity:${message}`);
    this.name = "IntegrityError";
  }
}

function subtle(): SubtleCrypto {
  const cryptoObj = (globalThis as unknown as { crypto?: Crypto }).crypto;
  const sub = cryptoObj?.subtle;
  if (!sub || typeof sub.digest !== "function") {
    throw new IntegrityError("SubtleCrypto unavailable — refusing weak-hash fallback");
  }
  return sub;
}

export async function sha256Hex(data: Uint8Array | Uint8ClampedArray | ArrayBuffer): Promise<string> {
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : (data as Uint8Array);
  const digest = await subtle().digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Deterministic JSON (sorted keys, recursive) for manifest hashing. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`);
  return `{${parts.join(",")}}`;
}

export async function sha256Json(value: unknown): Promise<string> {
  return sha256Hex(new TextEncoder().encode(stableStringify(value)));
}
