/* ------------------------------------------------------------------ *
 * Minimal synchronous PNG (RGBA, 8-bit) encoder for the product path.
 *
 * The sanitized image must be exportable anywhere the pipeline runs
 * (content script, panel, worker, node tests) without a canvas. This
 * encoder is deterministic: same pixels → same bytes, which keeps
 * pixel-verification and regression tests exact.
 * ------------------------------------------------------------------ */

function crcTable(): Int32Array {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
}

const CRC_TABLE = crcTable();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function u32be(value: number): Uint8Array {
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new Uint8Array([type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)]);
  const crc = crc32(concat([typeBytes, data]));
  return concat([u32be(data.length), typeBytes, data, u32be(crc)]);
}

/** DEFLATE with stored (uncompressed) blocks only (RFC 1951 §3.2.4):
 *  trivially correct, fully deterministic, decodable everywhere.
 *  Compression is deliberately skipped — screenshots stay byte-exact
 *  and the encoder has no tables to get wrong. */
function deflateStored(raw: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let off = 0; off < raw.length; off += 65535) {
    const end = Math.min(raw.length, off + 65535);
    const len = end - off;
    const last = end >= raw.length ? 1 : 0;
    out.push(last); // BFINAL + BTYPE=00 (stored), byte-aligned
    out.push(len & 0xff, (len >>> 8) & 0xff);
    out.push((~len) & 0xff, ((~len) >>> 8) & 0xff);
    for (let i = off; i < end; i++) out.push(raw[i]);
  }
  return new Uint8Array(out);
}

/** Adler-32 checksum for the zlib wrapper. */
function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

export function encodePng(width: number, height: number, rgba: Uint8ClampedArray | Uint8Array): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`encodePng: bad dimensions ${width}x${height}`);
  }
  if (rgba.length !== width * height * 4) {
    throw new Error(`encodePng: buffer length ${rgba.length} != ${width}x${height}x4`);
  }
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = new Uint8Array(13);
  ihdr[0] = (width >>> 24) & 0xff;
  ihdr[1] = (width >>> 16) & 0xff;
  ihdr[2] = (width >>> 8) & 0xff;
  ihdr[3] = width & 0xff;
  ihdr[4] = (height >>> 24) & 0xff;
  ihdr[5] = (height >>> 16) & 0xff;
  ihdr[6] = (height >>> 8) & 0xff;
  ihdr[7] = height & 0xff;
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // Scanlines with filter byte 0 (None). PNG row filters would shrink
  // output but add decoder-visible nondeterminism risk — keep it simple.
  const stride = 1 + width * 4;
  const raw = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < width * 4; x++) {
      raw[y * stride + 1 + x] = rgba[y * width * 4 + x];
    }
  }
  const deflated = deflateStored(raw);
  const zlib = concat([new Uint8Array([0x78, 0x01]), deflated, u32be(adler32(raw))]);
  return concat([signature, chunk("IHDR", ihdr), chunk("IDAT", zlib), chunk("IEND", new Uint8Array(0))]);
}

/** data:image/png;base64,… payload for the server-facing protocol. */
export function pngDataUrl(pngBytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 8192;
  for (let i = 0; i < pngBytes.length; i += CHUNK) {
    binary += String.fromCharCode(...pngBytes.subarray(i, i + CHUNK));
  }
  const b64 =
    typeof btoa === "function"
      ? btoa(binary)
      : (globalThis as unknown as { Buffer: { from(s: string, e: string): { toString(e: string): string } } }).Buffer.from(
          binary,
          "binary",
        ).toString("base64");
  return `data:image/png;base64,${b64}`;
}
