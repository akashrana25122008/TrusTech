/**
 * Generates TrusTech extension icons (16/48/128 PNG) with zero deps.
 * Draws a dark navy gradient with a cyan/violet orbital glow around a
 * miniature robot glyph, then box-averages down from 256px.
 */

import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "..", "extension", "icons");
const SRC = 256;

const crc = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
})();

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePNG(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 4 + 1);
    raw[row] = 0;
    rgba.copy(raw, row + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ---------- drawing ---------- */

function makeCanvas(size) {
  return { size, b: new Uint8ClampedArray(size * size * 4) };
}

function over(b, x, y, r, g, bl, a) {
  const { size } = b;
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const i = (y * size + x) * 4;
  const da = 1 - a;
  b.b[i] = Math.round(r * a + b.b[i] * da);
  b.b[i + 1] = Math.round(g * a + b.b[i + 1] * da);
  b.b[i + 2] = Math.round(bl * a + b.b[i + 2] * da);
  b.b[i + 3] = Math.round(255 * a + b.b[i + 3] * da);
}

function fillGradient(c, w, h, top, bottom) {
  for (let y = 0; y < h; y++) {
    const t = y / h;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      c.b[i] = Math.round(top[0] + (bottom[0] - top[0]) * t);
      c.b[i + 1] = Math.round(top[1] + (bottom[1] - top[1]) * t);
      c.b[i + 2] = Math.round(top[2] + (bottom[2] - top[2]) * t);
      c.b[i + 3] = 255;
    }
  }
}

function glow(c, cx, cy, r, col, strength) {
  const { size } = c;
  const [R, G, B] = col;
  const x0 = Math.max(0, Math.floor(cx - r * 1.6));
  const x1 = Math.min(size - 1, Math.ceil(cx + r * 1.6));
  const y0 = Math.max(0, Math.floor(cy - r * 1.6));
  const y1 = Math.min(size - 1, Math.ceil(cy + r * 1.6));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d < r * 1.6) {
        const f = Math.pow(1 - d / (r * 1.6), 2.2) * strength;
        over(c, x, y, R, G, B, Math.min(1, f));
      }
    }
  }
}

function ring(c, cx, cy, r, th, col, aInner) {
  const { size } = c;
  const [R, G, B] = col;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d >= r - th && d <= r + th) {
        const edge = Math.min(1, (r + th - d) / 2, (d - (r - th)) / 2);
        over(c, x, y, R, G, B, Math.min(1, aInner * edge));
      }
    }
  }
}

function disc(c, cx, cy, r, col, aEdge) {
  const { size } = c;
  const [R, G, B] = col;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d < r) {
        const edge = Math.max(0, Math.min(1, (r - d) / Math.max(1, r * 0.06)));
        over(c, x, y, R, G, B, aEdge * edge);
      }
    }
  }
}

function roundedRect(c, x0, y0, x1, y1, r, col, aEdge, soft = 0) {
  const { size } = c;
  const [R, G, B] = col;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = Math.max(x0 + r - x, x - (x1 - r), 0);
      const dy = Math.max(y0 + r - y, y - (y1 - r), 0);
      const d = Math.hypot(dx, dy);
      if (d <= r + soft) {
        const edge = Math.max(0, Math.min(1, (r + soft - d) / Math.max(1, soft * 2)));
        over(c, x, y, R, G, B, aEdge * (d <= r ? 1 : edge));
      }
    }
  }
}

function draw(src) {
  fillGradient(src, SRC, SRC, [18, 28, 54], [5, 8, 15]);

  // nebula glows
  glow(src, 92, 132, 140, [56, 216, 255], 0.16);
  glow(src, 172, 82, 110, [139, 123, 255], 0.14);
  glow(src, 128, 150, 96, [56, 216, 255], 0.08);

  // orbital rings
  ring(src, 128, 152, 104, 5, [56, 216, 255], 0.5);
  ring(src, 128, 152, 126, 3, [139, 123, 255], 0.4);

  // holographic platform
  disc(src, 128, 196, 56, [30, 60, 90], 0.5);
  ring(src, 128, 196, 54, 3, [56, 216, 255], 0.9);

  // robot body (rounded)
  roundedRect(src, 104, 180, 152, 226, 20, [46, 84, 130], 0.95, 2);
  roundedRect(src, 107, 183, 149, 223, 17, [10, 16, 28], 1);

  // head
  disc(src, 128, 138, 44, [12, 18, 32], 1);
  ring(src, 128, 138, 42, 4, [56, 216, 255], 0.85);

  // eyes + visor
  disc(src, 112, 132, 6.5, [142, 233, 255], 1);
  disc(src, 144, 132, 6.5, [142, 233, 255], 1);
  glow(src, 128, 138, 20, [56, 216, 255], 0.28);
  roundedRect(src, 108, 148, 148, 155, 4, [142, 233, 255], 0.9);

  // chest core
  disc(src, 128, 204, 6, [139, 123, 255], 1);
  glow(src, 128, 204, 18, [139, 123, 255], 0.4);
}

function downsample(src, size) {
  const out = { size, b: new Uint8ClampedArray(size * size * 4) };
  const s = SRC / size;
  for (let y = 0; y < size; y++) {
    const y0 = Math.floor(y * s);
    const y1 = Math.min(SRC - 1, Math.floor((y + 1) * s));
    for (let x = 0; x < size; x++) {
      const x0 = Math.floor(x * s);
      const x1 = Math.min(SRC - 1, Math.floor((x + 1) * s));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy <= y1; yy++) {
        for (let xx = x0; xx <= x1; xx++) {
          const i = (yy * SRC + xx) * 4;
          r += src.b[i];
          g += src.b[i + 1];
          b += src.b[i + 2];
          a += src.b[i + 3];
          n++;
        }
      }
      const i = (y * size + x) * 4;
      out.b[i] = Math.round(r / n);
      out.b[i + 1] = Math.round(g / n);
      out.b[i + 2] = Math.round(b / n);
      out.b[i + 3] = Math.round(a / n);
    }
  }
  return out;
}

mkdirSync(OUT, { recursive: true });

const src = makeCanvas(SRC);
draw(src);

for (const size of [128, 48, 16]) {
  const c = size === 128 ? src : downsample(src, size);
  const png = encodePNG(size, size, Buffer.from(c.b.buffer, c.b.byteOffset, c.b.byteLength));
  writeFileSync(join(OUT, `icon${size}.png`), png);
  console.log(`icon${size}.png -> ${png.length} bytes`);
}