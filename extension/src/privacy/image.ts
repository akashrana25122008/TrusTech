/* ------------------------------------------------------------------ *
 * Outbound image gate + local redaction painter.
 *
 * Enforcement rule: no probable-image payload (data URLs, long base64
 * blobs, binary buffers, canvas/bitmap handles, screenshot-named
 * fields) may leave the device unless it has passed through
 * `paintRedactions` in THIS module. Today no sender exists, so the
 * gate fails closed on every image payload; the painter is tested and
 * ready for the future sanctioned sender.
 *
 * Redaction never touches the live page — it paints a fresh canvas.
 * ------------------------------------------------------------------ */

export interface RedactionBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type RedactionMethod = "blackout";

/** Minimal 2D-context surface the painter needs (mockable in tests). */
export interface PaintContext {
  fillStyle: string;
  fillRect: (x: number, y: number, w: number, h: number) => void;
}

const DATA_URL_RE = /^\s*data:image\/[a-zA-Z+.-]+;base64,/;
const BASE64_BLOB_RE = /^[A-Za-z0-9+/=\s]{200,}$/;

/** True when a value looks like outbound image/binary content. */
export function isProbableImagePayload(value: unknown): boolean {
  if (typeof value === "string") {
    const compact = value.replace(/\s+/g, "");
    if (DATA_URL_RE.test(value)) return true;
    if (compact.length >= 200 && BASE64_BLOB_RE.test(compact)) return true;
    return false;
  }
  if (value instanceof ArrayBuffer) return true;
  if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(value)) return true;
  if (typeof Blob !== "undefined" && value instanceof Blob) return true;
  const tag = Object.prototype.toString.call(value);
  if (tag === "[object ImageBitmap]" || tag === "[object HTMLCanvasElement]" || tag === "[object OffscreenCanvas]") {
    return true;
  }
  return false;
}

/** True when a field name suggests screenshot/image content. */
export function isImageFieldName(key: string): boolean {
  return /screenshot|snapshot|image|photo|frame|bitmap|thumbnail|ocr[_-]?image/i.test(key);
}

/**
 * Merge overlapping boxes and clamp to the frame. Pure function —
 * the box math is unit-tested without a canvas.
 */
export function mergeRedactionBoxes(boxes: RedactionBox[], width: number, height: number): RedactionBox[] {
  // Proper intersection with the frame (wholly outside → dropped).
  const clamped: RedactionBox[] = [];
  for (const b of boxes) {
    const x = Math.max(0, b.x);
    const y = Math.max(0, b.y);
    const x2 = Math.min(b.x + b.w, width);
    const y2 = Math.min(b.y + b.h, height);
    if (x2 > x && y2 > y) clamped.push({ x, y, w: x2 - x, h: y2 - y });
  }

  const merged: RedactionBox[] = [];
  for (const box of clamped) {
    const target = merged.find(
      (m) => box.x < m.x + m.w && m.x < box.x + box.w && box.y < m.y + m.h && m.y < box.y + box.h,
    );
    if (!target) {
      merged.push({ ...box });
      continue;
    }
    const x2 = Math.max(target.x + target.w, box.x + box.w);
    const y2 = Math.max(target.y + target.h, box.y + box.h);
    target.x = Math.min(target.x, box.x);
    target.y = Math.min(target.y, box.y);
    target.w = x2 - target.x;
    target.h = y2 - target.y;
  }
  return merged;
}

/**
 * Paint blackout boxes onto a FRESH context (never the live page).
 * Returns the boxes painted, for the transmission proof record.
 */
export function paintRedactions(
  ctx: PaintContext,
  boxes: RedactionBox[],
  width: number,
  height: number,
  _method: RedactionMethod = "blackout",
): RedactionBox[] {
  const merged = mergeRedactionBoxes(boxes, width, height);
  ctx.fillStyle = "#000";
  for (const b of merged) ctx.fillRect(b.x, b.y, b.w, b.h);
  return merged;
}
