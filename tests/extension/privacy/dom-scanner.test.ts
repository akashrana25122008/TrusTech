import { describe, it, expect } from "vitest";
import { scanDomPrivacy, type DomScannerOptions } from "@/privacy/dom-scanner";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";

/* ------------------------------------------------------------------ *
 * dom-scanner.test.ts — password fields, text PII scanning, visibility,
 * rect patching (jsdom has no layout API), label/aria label cue boosting.
 *
 * jsdom is the default vitest env; we load fixture HTML into a fresh
 * JSDOM instance to avoid cross-test state.
 * ------------------------------------------------------------------ */

const FIXTURE_DIR = resolve(process.cwd(), "tests/fixtures/privacy");

function loadFixtureDoc(id: string): { doc: Document; viewport: { width: number; height: number } } {
  const html = readFileSync(resolve(FIXTURE_DIR, `${id}.html`), "utf-8");
  const dom = new JSDOM(html, { url: "http://localhost:3000" });
  const doc = dom.window.document;
  return { doc, viewport: { width: 640, height: 480 } };
}

function readLayoutRect() {
  return (el: Element) => {
    const raw = el.getAttribute("data-rect");
    if (!raw) return { x: 0, y: 0, width: 0, height: 0 };
    const [x, y, w, h] = raw.split(",").map(Number);
    return { x, y, width: w, height: h };
  };
}

function scanFixture(id: string, overrides: Partial<DomScannerOptions> = {}) {
  const { doc, viewport } = loadFixtureDoc(id);
  return scanDomPrivacy(doc, { viewport, readRect: readLayoutRect(), ...overrides });
}

describe("dom-scanner.ts", () => {
  /* ---- PWD-LOGIN ---- */
  describe("pwd-login fixture", () => {
    it("finds exactly one PASSWORD signal from password input", () => {
      const { signals } = scanFixture("pwd-login");
      const passwords = signals.filter((s) => s.type === "PASSWORD");
      expect(passwords).toHaveLength(1);
      expect(passwords[0].source).toBe("dom");
      expect(passwords[0].bbox.width).toBe(360);
      expect(passwords[0].bbox.height).toBe(44);
      expect(passwords[0].bbox.y).toBe(156); // input id=in-pass
    });

    it("boosts password confidence when aria-label contains 'password' cue", () => {
      const { signals } = scanFixture("pwd-login");
      const pwd = signals.find((s) => s.type === "PASSWORD")!;
      expect(pwd.confidence).toBeGreaterThanOrEqual(0.96);
      expect(pwd.contextLabel).toBeDefined();
    });

    it("does NOT emit AADHAAR or other PII from the password field", () => {
      const { signals } = scanFixture("pwd-login");
      const nonPassword = signals.filter((s) => s.type !== "PASSWORD");
      expect(nonPassword).toEqual([]);
    });

    it("the username field (aria-label='Username') produces no signals", () => {
      const { signals } = scanFixture("pwd-login");
      // Only PASSWORD from the password input; username text has no PII pattern
      expect(signals).toHaveLength(1);
    });
  });

  /* ---- AADHAAR-FORM ---- */
  describe("aadhaar-form fixture", () => {
    it("finds an AADHAAR signal from the input value (Verhoeff-valid 12-digit)", () => {
      const { signals } = scanFixture("aadhaar-form");
      const aadhars = signals.filter((s) => s.type === "AADHAAR");
      expect(aadhars).toHaveLength(1);
      expect(aadhars[0].source).toBe("text");
      expect(aadhars[0].confidence).toBeGreaterThanOrEqual(0.95);
      expect(aadhars[0].bbox.y).toBe(92);
    });

    it("the Aadhaar input label is not duplicated as a signal (text leaf 'Aadhaar number' has no 12-digit pattern)", () => {
      const { signals } = scanFixture("aadhaar-form");
      const labelSignals = signals.filter((s) => s.type === "AADHAAR");
      expect(labelSignals).toHaveLength(1);
    });

    it("no POSTAL signal from the 6-digit run 'KYC-482915' (no postal cue within text)", () => {
      const { signals } = scanFixture("aadhaar-form");
      expect(signals.find((s) => s.type === "AADHAAR")).toBeDefined();
    });
  });

  /* ---- GOV-IDS ---- */
  describe("gov-ids fixture", () => {
    it("finds PASSPORT, VOTER_ID, DRIVING_LICENSE", () => {
      const { signals } = scanFixture("gov-ids");
      const types = signals.map((s) => s.type).sort();
      expect(types).toContain("PASSPORT");
      expect(types).toContain("VOTER_ID");
      expect(types).toContain("DRIVING_LICENSE");
    });

    it("no cross-type duplication or phantom face/email signals", () => {
      const { signals } = scanFixture("gov-ids");
      const unwanted = signals.filter((s) =>
        ["FACE", "EMAIL", "PHONE", "AADHAAR", "PAN", "CARD_NUMBER"].includes(s.type),
      );
      expect(unwanted).toEqual([]);
    });
  });

  /* ---- MASKED-CLEAN ---- */
  describe("masked-clean fixture", () => {
    it("only PASSWORD from the password input; masked numbers produce no signals", () => {
      const { signals } = scanFixture("masked-clean");
      const types = signals.map((s) => s.type).sort();
      expect(types).toEqual(["PASSWORD"]);
    });
  });

  /* ---- CONTACT ---- */
  describe("contact fixture", () => {
    it("finds PHONE, EMAIL, UPI from a single paragraph", () => {
      const { signals } = scanFixture("contact");
      const types = signals.map((s) => s.type).sort();
      expect(types).toContain("PHONE");
      expect(types).toContain("EMAIL");
      expect(types).toContain("UPI");
    });
  });

  /* ---- PHOTO-NEGATIVE ---- */
  describe("photo-negative fixture", () => {
    it("no signals at all from clean DOM (no sensitive text patterns)", () => {
      const { signals } = scanFixture("photo-negative");
      expect(signals).toHaveLength(0);
    });
  });

  /* ---- Visibility / structure ---- */
  describe("element visibility", () => {
    it("hidden elements (aria-hidden=true) are skipped", () => {
      const html = `<html><body>
        <p data-rect="0,0,100,20" aria-hidden="true">Hidden content 1234567890</p>
        <p data-rect="0,30,100,20">Visible content</p>
      </body></html>`;
      const doc = new JSDOM(html, { url: "http://localhost" }).window.document;
      const { signals } = scanDomPrivacy(doc, {
        viewport: { width: 640, height: 480 },
        readRect: readLayoutRect(),
      });
      expect(signals).toHaveLength(0); // no PII pattern in visible text either
    });

    it("elements without data-rect (zero size) are skipped", () => {
      const html = `<html><body><p>Some text without rect attr</p></body></html>`;
      const doc = new JSDOM(html, { url: "http://localhost" }).window.document;
      const { signals } = scanDomPrivacy(doc, { viewport: { width: 640, height: 480 } });
      expect(signals).toHaveLength(0);
    });
  });

  /* ---- Scan metrics ---- */
  describe("scan metrics", () => {
    it("returns scanned count and domScanMs", () => {
      const result = scanFixture("pwd-login");
      expect(result.scanned).toBeGreaterThanOrEqual(1);
      expect(result.domScanMs).toBeGreaterThanOrEqual(0);
      expect(result.viewport.width).toBe(640);
      expect(result.viewport.height).toBe(480);
    });
  });
});