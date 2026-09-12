import { describe, it, expect } from "vitest";
import { detectPii, redactPii } from "@/privacy/detector";
import { PrivacyFirewall } from "@/privacy/firewall";

describe("detectPii", () => {
  it("finds emails, phones and cards", () => {
    const matches = detectPii("write to a@b.com, call +919876543210, card 4111-1111-1111-1111");
    const types = matches.map((m) => m.type);
    expect(types).toContain("email");
    expect(types).toContain("phone");
    expect(types).toContain("credit_card");
  });

  it("does not fire on benign text", () => {
    expect(detectPii("read the docs and watch the tutorial")).toHaveLength(0);
  });
});

describe("redactPii", () => {
  it("masks segments without leaking values", () => {
    const text = "contact +919876543210";
    const out = redactPii(text, detectPii(text), false);
    expect(out).toBe("contact [phone]");
  });
});

describe("PrivacyFirewall", () => {
  it("raises ALERT and blocks on financial-grade PII", () => {
    const firewall = new PrivacyFirewall();
    const scan = firewall.scan("pay with card 4111-1111-1111-1111");
    expect(scan.verdict).toBe("ALERT");
    expect(scan.redactions.some((r) => r.type === "credit_card")).toBe(true);
    expect(firewall.isBlocked(scan.verdict)).toBe(true);
  });

  it("stays SAFE on clean content and lets traffic through", () => {
    const firewall = new PrivacyFirewall();
    const scan = firewall.scan("nothing sensitive here");
    expect(scan.verdict).toBe("SAFE");
    expect(firewall.isBlocked(scan.verdict)).toBe(false);
  });

  it("scores medium/low for ordinary PII (email/phone) without hard-blocking", () => {
    const firewall = new PrivacyFirewall();
    const scan = firewall.scan("my email a@b.com and phone 9876543210");
    expect(scan.verdict).toBe("SCANNING");
    expect(scan.score).toBeGreaterThan(0);
    expect(scan.score).toBeLessThan(100);
    expect(firewall.isBlocked(scan.verdict)).toBe(false);
  });

  it("hardBlock=false downgrades credit-card grade to sanitized (not blocked)", () => {
    const firewall = new PrivacyFirewall();
    const scan = firewall.scan("pay with card 4111-1111-1111-1111", { hardBlock: false });
    expect(scan.verdict).toBe("SCANNING");
    // Value must still be masked before anything leaves.
    expect(scan.sanitized).not.toContain("4111-1111-1111-1111");
    expect(scan.sanitized).toContain("[card]");
    expect(firewall.isBlocked(scan.verdict)).toBe(false);
  });

  it("keepLength preserves the raw length for debugging but never the value", () => {
    const firewall = new PrivacyFirewall();
    const scan = firewall.scan("contact +919876543210", { keepLength: true, hardBlock: false });
    // length preserved (13 chars = "+919876543210") but the digits are gone
    const masked = scan.sanitized.split("contact ")[1];
    expect(masked?.length).toBe(13);
    expect(masked).not.toContain("9876543210");
  });
});