/**
 * Feature #1 — Multilingual / Indian regional script PII detection.
 * Real engine coverage: Verhoeff-validated Aadhaar, PAN structure,
 * Indic-digit folding with offset mapping, UPI/IFSC/passport/voter/DL,
 * Hindi+Hinglish context, fusion dedup, provenance, and the OCR seam.
 */
import { describe, it, expect } from "vitest";
import { detectPii, redactPii } from "@/privacy/detector";
import { normalizeForDetection, toOriginalSpan, detectLanguage } from "@/privacy/scripts";
import { verhoeffValid, verhoeffCheckDigit, detectIndia } from "@/privacy/india";
import { scanSources, scanText, scanVisualText } from "@/privacy/fusion";

// Synthetic Verhoeff-valid Aadhaar fixture (generated, never a real number).
const AADHAAR_11 = "23456789012";
const AADHAAR = `${AADHAAR_11.slice(0, 4)} ${AADHAAR_11.slice(4, 8)} ${AADHAAR_11.slice(8)}${verhoeffCheckDigit(AADHAAR_11)}`;
const AADHAAR_BAD = `${AADHAAR.slice(0, -1)}${AADHAAR.endsWith("0") ? "1" : "0"}`;

const DEVA_DIGITS = ["०", "१", "२", "३", "४", "५", "६", "७", "८", "९"];
const toDeva = (ascii: string) => ascii.replace(/\d/g, (d) => DEVA_DIGITS[Number(d)]);

describe("Verhoeff checksum", () => {
  it("accepts a generated-valid 12-digit number and rejects a flipped digit", () => {
    const digits = AADHAAR.replace(/\s/g, "");
    expect(digits).toMatch(/^\d{12}$/);
    expect(verhoeffValid(digits)).toBe(true);
    expect(verhoeffValid(AADHAAR_BAD.replace(/\s/g, ""))).toBe(false);
  });
});

describe("normalization with offset mapping", () => {
  it("folds Devanagari digits and maps spans back to the original", () => {
    const raw = `संपर्क ${toDeva("9876543210")} करें`;
    const norm = normalizeForDetection(raw);
    expect(norm.text).toContain("9876543210");
    const start = norm.text.indexOf("9876543210");
    const span = toOriginalSpan(norm, start, start + 10);
    expect(raw.slice(span.start, span.end)).toBe(toDeva("9876543210"));
  });

  it("strips zero-width characters without breaking spans", () => {
    const raw = "98​76543210";
    const norm = normalizeForDetection(raw);
    expect(norm.text).toBe("9876543210");
    const span = toOriginalSpan(norm, 0, 10);
    expect(raw.slice(span.start, span.end).replace(/​/g, "")).toBe("9876543210");
  });

  it("detects Hindi vs Hinglish vs English hints", () => {
    expect(detectLanguage("आधार संख्या")).toBe("hi");
    expect(detectLanguage("mobile number", "mera aadhar card")).toBe("hinglish");
    expect(detectLanguage("call me tomorrow")).toBe("en");
  });
});

describe("Indian identifier detectors", () => {
  it("detects a Verhoeff-valid Aadhaar with high confidence", () => {
    const found = scanText(`my id ${AADHAAR} ok`);
    const aadhaar = found.filter((f) => f.type === "aadhaar");
    expect(aadhaar).toHaveLength(1);
    expect(aadhaar[0].confidence).toBeGreaterThanOrEqual(0.9);
    expect(aadhaar[0].segment).toBe(AADHAAR);
  });

  it("keeps an invalid-checksum 12-digit run as a weak candidate", () => {
    const found = scanText(`id ${AADHAAR_BAD} ok`);
    const aadhaar = found.filter((f) => f.type === "aadhaar");
    expect(aadhaar).toHaveLength(1);
    expect(aadhaar[0].confidence).toBeLessThan(0.9);
  });

  it("detects Aadhaar written in Devanagari digits with original spans", () => {
    const deva = toDeva(AADHAAR.replace(/\s/g, ""));
    const raw = `मेरा आधार ${deva} है`;
    const found = scanText(raw);
    const aadhaar = found.filter((f) => f.type === "aadhaar");
    expect(aadhaar).toHaveLength(1);
    expect(raw.slice(aadhaar[0].start, aadhaar[0].end)).toBe(deva);
    expect(aadhaar[0].language).toBe("hi");
    // Redaction removes the real digits.
    const redacted = redactPii(raw, detectPii(raw));
    expect(redacted).not.toContain(deva);
    expect(redacted).toContain("[aadhaar]");
  });

  it("validates PAN structure (entity + status codes)", () => {
    const good = scanText("PAN ABCPP1234F submitted");
    expect(good.filter((f) => f.type === "pan")).toHaveLength(1);
    expect(good.find((f) => f.type === "pan")!.confidence).toBeGreaterThanOrEqual(0.9);
    const weak = scanText("code ABCDE1234F here");
    const weakPan = weak.filter((f) => f.type === "pan");
    expect(weakPan).toHaveLength(1);
    expect(weakPan[0].confidence).toBeLessThan(0.9);
  });

  it("detects Indian mobiles in +91 / 0 / bare / Devanagari forms", () => {
    for (const variant of ["+919876543210", "+91 98765 43210", "09876543210", "9876543210", toDeva("9876543210")]) {
      const found = scanText(`call ${variant} now`);
      expect(found.filter((f) => f.type === "phone")).toHaveLength(1);
    }
  });

  it("detects UPI handles but never e-mails", () => {
    const upi = scanText("pay to rahul.sharma@okhdfc please");
    expect(upi.filter((f) => f.type === "upi")).toHaveLength(1);
    expect(upi.filter((f) => f.type === "email")).toHaveLength(0);
    const email = scanText("write to a@b.com today");
    expect(email.filter((f) => f.type === "email")).toHaveLength(1);
    expect(email.filter((f) => f.type === "upi")).toHaveLength(0);
  });

  it("detects IFSC, passport, voter EPIC and driving licence", () => {
    const found = scanText("IFSC HDFC0001234 passport A1234567 voter ABC1234567 dl DL1420110012345");
    const types = found.map((f) => f.type);
    expect(types).toContain("ifsc");
    expect(types).toContain("passport");
    expect(types).toContain("voter_id");
    expect(types).toContain("driving_licence");
  });
});

describe("context, fusion and dedup", () => {
  it("Hindi/Hinglish cues boost confidence and record the label", () => {
    const hindi = scanText(`मेरा आधार नंबर ${AADHAAR} है`);
    const hit = hindi.find((f) => f.type === "aadhaar")!;
    expect(hit.confidence).toBeGreaterThanOrEqual(0.95);
    expect(hit.contextLabel).toBeDefined();
    const hinglish = scanText(`mera mobile number 9876543210 hai`);
    const phone = hinglish.find((f) => f.type === "phone")!;
    expect(phone.language).toBe("hinglish");
    expect(phone.contextLabel).toBeDefined();
  });

  it("an Aadhaar run emits one finding, not phone/postal fragments", () => {
    const found = scanText(`id ${AADHAAR} done`);
    expect(found.filter((f) => f.type === "aadhaar")).toHaveLength(1);
    expect(found.filter((f) => f.type === "phone")).toHaveLength(0);
    expect(found.filter((f) => f.type === "postal")).toHaveLength(0);
  });

  it("voter EPIC wins over its passport-shaped tail", () => {
    const found = scanText("epic ABC1234567");
    expect(found.filter((f) => f.type === "voter_id")).toHaveLength(1);
    expect(found.filter((f) => f.type === "passport")).toHaveLength(0);
  });

  it("benign text stays clean across scripts", () => {
    expect(scanText("read the docs and watch the tutorial")).toHaveLength(0);
    expect(scanText("यह एक साधारण सूचना है")).toHaveLength(0);
  });
});

describe("provenance and the visual-text seam", () => {
  it("field values and labels carry their provenance", () => {
    const found = scanSources([
      { text: "Customer name", provenance: "field-label" },
      { text: "9876543210", provenance: "field-value" },
    ]);
    const phone = found.find((f) => f.type === "phone")!;
    expect(phone.provenance).toBe("field-value");
  });

  it("OCR text runs the same pipeline with ocr provenance", () => {
    const found = scanVisualText({ text: `AADHAAR ${AADHAAR}`, width: 800, height: 600 });
    const aadhaar = found.filter((f) => f.type === "aadhaar");
    expect(aadhaar).toHaveLength(1);
    expect(aadhaar[0].provenance).toBe("ocr");
    expect(scanVisualText({ text: "" })).toHaveLength(0);
  });

  it("detectors run on normalized text (raw india entry)", () => {
    const norm = normalizeForDetection(`upi rahul@okhdfc ${toDeva("9876543210")}`);
    const kinds = detectIndia(norm).map((h) => h.kind);
    expect(kinds).toContain("upi");
    expect(kinds).toContain("phone_in");
  });
});
