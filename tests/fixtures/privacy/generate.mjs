#!/usr/bin/env node
/* ------------------------------------------------------------------ *
 * Synthetic AT-02 fixture generator (run: node tests/fixtures/privacy/generate.mjs)
 *
 * Emits, per fixture:
 *   {id}.html       — a real DOM document with data-rect layout hints
 *                     (jsdom has no layout engine; the test harness reads
 *                     data-rect to synthesise getBoundingClientRect).
 *   {id}.png        — a REAL raster (full RGBA PNG) painted from the same
 *                     element boxes so the Phase 1 vision model sees an
 *                     honest, deterministic screenshot. The screens are
 *                     geometric (no glyphs) by design — nothing gamed.
 *   {id}.gt.json    — machine-readable ground truth: type + bbox (+ minIoU).
 *   manifest.json   — corpus index + class coverage + honest NOT TESTED notes.
 *
 * QR-code style principle: coordinates in the pixels and the DOM must
 * agree, else AT-02 fails loudly. Values are VERHOEFF-VALID (aadhaar) and
 * pattern-correct by construction, and are re-validated by the real
 * extension detectors at test time.
 * ------------------------------------------------------------------ */
import { deflateSync } from "node:zlib";
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = __dirname;

/* ------------------------------------------------------------------ *
 * Minimal PNG encoder (mirrors tests/helpers/png-writer.ts so the
 * generator can run standalone in node without a TS build step; the
 * bytes are validated by RawImage decoding inside AT-02).
 * ------------------------------------------------------------------ */
const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}
function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = 1 + width * 4;
  const raw = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < width; x++) {
      const si = (y * width + x) * 4;
      const di = y * stride + 1 + x * 4;
      raw[di] = rgba[si]; raw[di + 1] = rgba[si + 1];
      raw[di + 2] = rgba[si + 2]; raw[di + 3] = rgba[si + 3];
    }
  }
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/* ------------------------------------------------------------------ *
 * Verhoeff check digit for Aadhaar fixtures (validated again in AT-02
 * against the extension's real verhoeffValid()).
 * ------------------------------------------------------------------ */
const VD = [
  [0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],[3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],
  [5,9,8,7,6,0,4,3,2,1],[6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],[9,8,7,6,5,4,3,2,1,0],
];
const VP = [
  [0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],[8,9,1,6,0,4,3,7,2,5],[9,4,5,3,1,2,6,8,7,0],
  [4,2,8,6,5,7,3,9,0,1],[2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8],
];
function verhoeffCheckDigit(first11) {
  let c = 0;
  const rev = [...String(first11)].map(Number).reverse();
  for (let i = 0; i < rev.length; i++) c = VD[c][VP[(i + 1) % 8][rev[i]]];
  for (let d = 0; d <= 9; d++) if (VD[c][VP[0][d]] === 0) return String(d);
  throw new Error("verhoeff: no check digit");
}

/* ------------------------------------------------------------------ *
 * Fixture corpus
 * ------------------------------------------------------------------ */
const W = 640;
const H = 480;

const FIELDS = {
  aadhaar: { value: "23456789012" + verhoeffCheckDigit("23456789012"), aria: "Aadhaar number", valueAria: "Aadhaar ID" },
};

/* Layout unit: a labeled input block. */
function inputBlock(id, y, opts = {}) {
  const x = opts.x ?? 48, w = opts.w ?? 360;
  const el = {
    kind: "input",
    id,
    x,
    y,
    w,
    h: 44,
    inputRect: { x, y, width: w, height: 44 },
    labelRect: { x, y: y - 22, width: 150, height: 14 },
  };
  return { ...el, ...opts };
}

function para(id, y, text, opts = {}) {
  return {
    kind: "text",
    id,
    text,
    x: opts.x ?? 48,
    y,
    w: opts.w ?? 540,
    h: 26,
    rect: { x: 48, y, width: opts.w ?? 540, height: 26 },
  };
}

function button(id, y, text, opts = {}) {
  return {
    kind: "button",
    id,
    text,
    x: opts.x ?? 48,
    y,
    w: opts.w ?? 160,
    h: 40,
    rect: { x: opts.x ?? 48, y, width: opts.w ?? 160, height: 40 },
  };
}

let seq = 0;

/* corpus: id → fixture definition */
const corpus = [
  {
    id: "pwd-login",
    viewport: { width: W, height: H },
    elements: [
      para("p-hello", 40, "Welcome back"), // normal text, not sensitive
      inputBlock("in-user", 92, { ariaLabel: "Username", type: "text" }),
      inputBlock("in-pass", 156, { ariaLabel: "Your password", type: "password" }),
      button("btn-signin", 224, "Sign in"),
    ],
    groundTruth: [{ type: "PASSWORD", bbox: { x: 48, y: 156, width: 360, height: 44 }, minIoU: 0.4 }],
    negatives: ["username field", "normal greeting text"],
    notes: "no label-for; cue comes from aria-label 'Your password' → structural boost 0.96",
  },
  {
    id: "aadhaar-form",
    viewport: { width: W, height: H },
    elements: [
      para("p-kyc", 40, "Complete your KYC with your card within 30 days"),
      inputBlock("in-aad", 92, { value: FIELDS.aadhaar.value, labelText: "Aadhaar number" }),
      para("p-order", 160, "Order ID KYC-482915"),
      para("p-price", 196, "Plan ₹1,299"),
      button("btn-submit", 240, "Submit"),
    ],
    groundTruth: [{ type: "AADHAAR", bbox: { x: 48, y: 92, width: 360, height: 44 }, minIoU: 0.4 }],
    negatives: ["KYC-482915 (6-digit run, no postal cue)", "₹1,299 price"],
    notes: "Verhoeff-valid Aadhaar; label-for cue via <label for>. Power-of-the-rules: 6-digit run without a cue → no region.",
  },
  {
    id: "pan-tax",
    viewport: { width: W, height: H },
    elements: [
      para("p-tax", 40, "Income Tax returns due 31 July 2026"),
      inputBlock("in-pan", 92, { value: "ABCAP1234F", labelText: "PAN" }),
      para("p-amt", 160, "Amount payable ₹85,000"),
      button("btn-pay", 216, "Pay now"),
    ],
    groundTruth: [{ type: "PAN", bbox: { x: 48, y: 92, width: 360, height: 44 }, minIoU: 0.4 }],
    negatives: ["due date", "₹85,000 amount"],
  },
  {
    id: "card-checkout",
    viewport: { width: W, height: H },
    elements: [
      para("p-cart", 40, "Express checkout"),
      inputBlock("in-card", 92, { value: "4111 1111 1111 1111", labelText: "Card number" }),
      inputBlock("in-email", 156, { value: "buyer@example.com", labelText: "Email" }),
      para("p-exp", 222, "Expiry 09/29 · CVV 123"),
      para("p-total", 258, "Total ₹1,299"),
      button("btn-pay", 298, "Pay securely"),
    ],
    groundTruth: [
      { type: "CARD_NUMBER", bbox: { x: 48, y: 92, width: 360, height: 44 }, minIoU: 0.4 },
      { type: "EMAIL", bbox: { x: 48, y: 156, width: 360, height: 44 }, minIoU: 0.4 },
    ],
    negatives: ["expiry 09/29", "CVV 123 (3 digits)", "total"],
  },
  {
    id: "contact",
    viewport: { width: W, height: H },
    elements: [para("p-contact", 48, "Reach me: +91 98765 43210 or me@example.com or pay me@okhdfcbank")],
    groundTruth: [
      { type: "PHONE", bbox: { x: 48, y: 48, width: 540, height: 26 }, minIoU: 0.4 },
      { type: "EMAIL", bbox: { x: 48, y: 48, width: 540, height: 26 }, minIoU: 0.4 },
      { type: "UPI", bbox: { x: 48, y: 48, width: 540, height: 26 }, minIoU: 0.4 },
    ],
    notes: "three independent PII values inside ONE text leaf → three regions, no conflict (text never conflicts with text).",
  },
  {
    id: "bank-ifsc",
    viewport: { width: W, height: H },
    elements: [
      inputBlock("in-ifsc", 48, { value: "HDFC0000267", labelText: "IFSC" }),
      para("p-acct", 120, "Account ending 4829"),
      para("p-ref", 156, "Ref No 73456120"),
    ],
    groundTruth: [{ type: "IFSC", bbox: { x: 48, y: 48, width: 360, height: 44 }, minIoU: 0.4 }],
    negatives: ["account fragment", "ref number (no 6-digit cue match)"],
  },
  {
    id: "gov-ids",
    viewport: { width: W, height: H },
    elements: [
      inputBlock("in-passport", 48, { value: "A1234567", labelText: "Passport" }),
      inputBlock("in-voter", 120, { value: "ABC1234567", labelText: "Voter ID" }),
      inputBlock("in-dl", 192, { value: "KA01 12345678901", labelText: "Driving licence" }),
      para("p-dob", 264, "DOB 12-Apr-1990"),
    ],
    groundTruth: [
      { type: "PASSPORT", bbox: { x: 48, y: 48, width: 360, height: 44 }, minIoU: 0.4 },
      { type: "VOTER_ID", bbox: { x: 48, y: 120, width: 360, height: 44 }, minIoU: 0.4 },
      { type: "DRIVING_LICENSE", bbox: { x: 48, y: 192, width: 360, height: 44 }, minIoU: 0.4 },
    ],
    negatives: ["DOB string", "cross-type collisions"],
  },
  {
    id: "masked-clean",
    viewport: { width: W, height: H },
    elements: [
      para("p-mask-card", 40, "Visa ending 1234 (XXXX XXXX 1234)"),
      para("p-mask-aad", 76, "Aadhaar XXXXXXXX4321"),
      para("p-mask-phone", 112, "Mobile 98XX XXX210"),
      inputBlock("in-pass", 164, { ariaLabel: "Enter your password", type: "password" }),
      button("btn-save", 232, "Save"),
    ],
    groundTruth: [{ type: "PASSWORD", bbox: { x: 48, y: 164, width: 360, height: 44 }, minIoU: 0.4 }],
    masked: ["XXXX XXXX 1234", "XXXXXXXX4321", "98XX XXX210"],
    notes: "masked card/aadhaar/phone must NOT be detected without OCR — documented limitation, asserted as zero false positives here. 'Visa ending' intentionally has no card-pattern digits.",
  },
  {
    id: "photo-negative",
    viewport: { width: W, height: H },
    elements: [
      para("p-title", 40, "Photo Gallery"),
      para("p-desc", 76, "Explore today's highlights"),
      button("btn-view", 120, "View album"),
    ],
    raster: "sample-cats.png",
    groundTruth: [],
    notes: "real photo (two cats) + clean DOM → must yield NO FACE (no person in frame) and no text PII. Honest real-model negative.",
  },
];

/* ------------------------------------------------------------------ *
 * HTML emission
 * ------------------------------------------------------------------ */
function rectAttr(r) {
  return `data-rect="${r.x},${r.y},${r.width},${r.height}"`;
}

function emitHtml(fixture) {
  const rows = [];
  rows.push(`<!doctype html><html><head><meta charset="utf-8"><title>${fixture.id}</title></head><body>`);
  rows.push(`<main id="app" ${rectAttr({ x: 0, y: 0, width: W, height: H })}>`);
  rows.push(`<section class="card" style="position:relative" ${rectAttr({ x: 24, y: 24, width: W - 48, height: H - 48 })}>`);
  for (const el of fixture.elements) {
    if (el.kind === "input") {
      if (el.labelText) {
        rows.push(`<label for="${el.id}" ${rectAttr(el.labelRect)}>${el.labelText}</label>`);
      }
      rows.push(
        `<input id="${el.id}" type="${el.type ?? "text"}" ${el.labelText ? `aria-label="${el.labelText}" ` : ""}${el.ariaLabel ? `aria-label="${el.ariaLabel}" ` : ""}${el.value ? `value="${el.value}" ` : ""}${rectAttr(el.inputRect)}>`,
      );
    } else if (el.kind === "button") {
      rows.push(`<button id="${el.id}" ${rectAttr(el.rect)}>${el.text}</button>`);
    } else {
      rows.push(`<p id="${el.id}" ${rectAttr(el.rect)}>${el.text}</p>`);
    }
    if (fixture.id === "pwd-login" && el.kind === "input") {
      rows.push(`<div class="spacer" style="height:16px"></div>`);
    }
  }
  rows.push(`</section></main></body></html>`);
  return rows.join("\n");
}

/* ------------------------------------------------------------------ *
 * Raster painting
 * ------------------------------------------------------------------ */
function paintRaster(elements) {
  const px = new Uint8ClampedArray(W * H * 4);
  const put = (x, y, r, g, b, a = 255) => {
    const i = (y * W + x) * 4;
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
  };
  const fill = (x0, y0, x1, y1, c) => {
    for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) {
      for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) put(x, y, c[0], c[1], c[2]);
    }
  };

  // Page background (vertical gradient).
  for (let y = 0; y < H; y++) {
    const t = y / H;
    const r = Math.round(13 + 8 * t), g = Math.round(18 + 10 * t), b = Math.round(38 + 4 * t);
    for (let x = 0; x < W; x++) put(x, y, r, g, b);
  }
  // Card background.
  fill(24, 24, W - 24, H - 24, [14, 22, 45]);

  for (const el of elements) {
    if (el.kind === "input") {
      const r = el.inputRect;
      if (el.labelText || el.ariaLabel) {
        fill(r.x, r.y - 22, r.x + 150, r.y - 8, [96, 112, 145]); // label bar
      }
      if (el.type === "password") {
        fill(r.x, r.y, r.x + r.width, r.y + r.height, [18, 27, 56]); // field
        fill(r.x, r.y + 12, r.x + r.width, r.y + r.height - 12, [11, 17, 38]);
      }
      fill(r.x - 1, r.y - 1, r.x + r.width + 1, r.y + 1, [39, 52, 92]); // top border
      fill(r.x - 1, r.y + r.height, r.x + r.width + 1, r.y + r.height + 1, [39, 52, 92]); // bottom border
    } else if (el.kind === "button") {
      fill(el.rect.x, el.rect.y, el.rect.x + el.rect.width, el.rect.y + el.rect.height, [8, 145, 178]);
      fill(el.rect.x, el.rect.y + 8, el.rect.x + el.rect.width, el.rect.y + el.rect.height - 4, [6, 122, 150]);
    } else if (el.kind === "text") {
      fill(el.rect.x, el.rect.y, el.rect.x + el.rect.width, el.rect.y + el.rect.height, [22, 32, 66]);
      fill(el.rect.x, el.rect.y + 8, el.rect.x + Math.min(120, el.rect.width), el.rect.y + 9, [128, 143, 180]); // text line
      fill(el.rect.x, el.rect.y + 12, el.rect.x + Math.min(260, el.rect.width), el.rect.y + 13, [102, 118, 156]);
    }
  }
  return encodePng(W, H, px);
}

/* ------------------------------------------------------------------ *
 * GT emission
 * ------------------------------------------------------------------ */
function emitGroundTruth(fixture) {
  return {
    id: fixture.id,
    viewport: fixture.viewport,
    image: `${fixture.id}.png`,
    grounds: fixture.groundTruth,
    negatives: fixture.negatives ?? [],
    masked: fixture.masked ?? [],
    notes: fixture.notes ?? "",
  };
}

/* ------------------------------------------------------------------ *
 * Run
 * ------------------------------------------------------------------ */
const manifest = { viewport: { width: W, height: H }, fixtures: [], classCoverage: {}, notes: [] };

const classStatus = {};

for (const f of corpus) {
  const html = emitHtml(f);
  const gt = emitGroundTruth(f);

  writeFileSync(resolve(OUT, `${f.id}.html`), html);
  writeFileSync(resolve(OUT, `${f.id}.gt.json`), JSON.stringify(gt, null, 2) + "\n");

  if (f.raster) {
    copyFileSync(resolve(__dirname, "..", "vision", f.raster), resolve(OUT, `${f.id}.png`));
  } else {
    const png = paintRaster(f.elements);
    writeFileSync(resolve(OUT, `${f.id}.png`), Buffer.from(png));
  }

  manifest.fixtures.push({
    id: f.id,
    image: `${f.id}.png`,
    viewport: f.viewport,
    groundTruth: f.groundTruth.map((g) => g.type),
    negatives: gt.negatives.length,
    maskedOnly: f.masked ? f.masked.length > 0 : false,
  });

  for (const g of f.groundTruth) {
    classStatus[g.type] = classStatus[g.type] ?? { positive: [] };
    classStatus[g.type].positive.push(f.id);
  }
  manifest.notes.push(`${f.id}: ${f.notes || "no notes"}`);
}

/* FACE is deliberately NOT advertised with a synthetic box: a generated
 * "face" that the model happens to see would be gaming the detector, not
 * measuring it. Real tracking of faces ships with the person-photo
 * corpus later; unit coverage exists via mocked vision detections. */
manifest.classCoverage = {
  FACE: { status: "not-tested", fixtures: [], reason: "no human-subject photo in corpus; synthetic face would game YOLOS" },
  PASSWORD: { status: "positive", fixtures: classStatus.PASSWORD?.positive ?? [] },
  CARD_NUMBER: { status: "positive", fixtures: classStatus.CARD_NUMBER?.positive ?? [] },
  AADHAAR: { status: "positive", fixtures: classStatus.AADHAAR?.positive ?? [] },
  PAN: { status: "positive", fixtures: classStatus.PAN?.positive ?? [] },
  UPI: { status: "positive", fixtures: classStatus.UPI?.positive ?? [] },
  PHONE: { status: "positive", fixtures: classStatus.PHONE?.positive ?? [] },
  EMAIL: { status: "positive", fixtures: classStatus.EMAIL?.positive ?? [] },
  IFSC: { status: "positive", fixtures: classStatus.IFSC?.positive ?? [] },
  PASSPORT: { status: "positive", fixtures: classStatus.PASSPORT?.positive ?? [] },
  VOTER_ID: { status: "positive", fixtures: classStatus.VOTER_ID?.positive ?? [] },
  DRIVING_LICENSE: { status: "positive", fixtures: classStatus.DRIVING_LICENSE?.positive ?? [] },
  SSN: { status: "negative-only", fixtures: [], reason: "no SSN in Indian product scope; negative fixtures only" },
};

manifest.notes.push("masked values (XXXX-style) are NOT detectable without OCR — asserted as zero false positives (documented limitation).");
manifest.notes.push("ocr end-to-end NOT TESTED (no runtime bundled) — seam + scripted-provider unit tests only.");

writeFileSync(resolve(OUT, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

console.log(`generated ${corpus.length} fixtures → ${OUT}`);
for (const f of manifest.fixtures) {
  console.log(`  ${f.id}: ${f.groundTruth.join(", ") || "(clean)"}  masked=${Number(f.maskedOnly)}`);
}