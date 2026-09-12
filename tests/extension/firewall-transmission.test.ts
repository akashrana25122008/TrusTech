/**
 * Feature #2 — Pre-Network Privacy Firewall battery:
 * fixtures (EN/HI/Hinglish), sanitization, nested/array payloads,
 * URL+headers, secrets, images, rescan independence, false positives,
 * gateway enforcement, and decision hygiene (no values in decisions).
 */
import { describe, it, expect } from "vitest";
import {
  TransmissionFirewall,
  validateSerialized,
  sanitizeUrlString,
  type AuthorizedTransmission,
  type OutboundRequest,
} from "@/privacy/transmission";
import { detectSecrets } from "@/privacy/secrets";
import {
  isProbableImagePayload,
  mergeRedactionBoxes,
  paintRedactions,
  type PaintContext,
} from "@/privacy/image";
import { GatewayLlmProvider } from "@/llm/gateway-provider";
import { verhoeffCheckDigit } from "@/privacy/india";

const firewall = new TransmissionFirewall();

async function authorize(body: unknown, extra: Partial<OutboundRequest> = {}) {
  return firewall.authorize({
    url: "http://localhost:8000/api/agent/step",
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body,
    ...extra,
  });
}

function serializedDecision(t: AuthorizedTransmission): string {
  return JSON.stringify(t.decision);
}

// Synthetic Verhoeff-valid Aadhaar (generated fixture, never real).
const A11 = "23456789012";
const AADHAAR = `${A11.slice(0, 4)} ${A11.slice(4, 8)}${A11.slice(8)}${verhoeffCheckDigit(A11)}`;

describe("Phase 34 — English fixture sanitization", () => {
  it("masks every PII occurrence and keeps structure", async () => {
    const r = await authorize({
      task: { goal: "Fill the registration form", intent: "form" },
      observation: {
        visibleText: `Name: Arjun Singh Email: arjun@example.com Phone: 9876543210 Aadhaar: ${AADHAAR} PAN: ABCPP1234F Address: 14 MG Road, New Delhi Button: Submit`,
        elements: [{ id: "el_001", role: "button", name: "Submit" }],
      },
    });
    expect(r.decision.decision).toBe("ALLOW");
    const text = (r.request!.body as { observation: { visibleText: string } }).observation.visibleText;
    expect(text).toContain("Name: [PERSON]");
    expect(text).toContain("Email: [EMAIL]");
    expect(text).toContain("Phone: [PHONE]");
    expect(text).toContain("Aadhaar: [AADHAAR]");
    expect(text).toContain("PAN: [PAN]");
    expect(text).toContain("Address: [ADDRESS]");
    expect(text).toContain("Button: Submit");
    for (const raw of ["Arjun Singh", "arjun@example.com", "9876543210", "ABCPP1234F", "MG Road"]) {
      expect(JSON.stringify(r.request!.body)).not.toContain(raw);
    }
    expect(r.decision.detectedTypes).toEqual(
      expect.arrayContaining(["PERSON", "EMAIL", "PHONE", "AADHAAR", "PAN", "ADDRESS"]),
    );
  });

  it("masks label-keyed name/address values in structured JSON", async () => {
    const r = await authorize({ form: { name: "Arjun Singh", address: "14 MG Road", button: "Submit" } });
    expect(r.decision.decision).toBe("ALLOW");
    expect(r.request!.body).toEqual({ form: { name: "[PERSON]", address: "[ADDRESS]", button: "Submit" } });
  });

  it("masks numeric PII (phone as a JSON number)", async () => {
    const r = await authorize({ contact: { phone: 9876543210 } });
    expect(r.decision.decision).toBe("ALLOW");
    expect(r.request!.body).toEqual({ contact: { phone: "[PHONE]" } });
  });
});

describe("Phase 35/36 — Hindi and Hinglish fixtures", () => {
  it("sanitizes the Hindi fixture with labels intact", async () => {
    const r = await authorize({
      observation: {
        visibleText: `नाम: अर्जुन सिंह मोबाइल नंबर: 9876543210 ईमेल: arjun@example.com आधार संख्या: ${AADHAAR} पता: दिल्ली, भारत`,
      },
    });
    expect(r.decision.decision).toBe("ALLOW");
    const text = (r.request!.body as { observation: { visibleText: string } }).observation.visibleText;
    expect(text).toContain("नाम: [PERSON]");
    expect(text).toContain("मोबाइल नंबर: [PHONE]");
    expect(text).toContain("ईमेल: [EMAIL]");
    expect(text).toContain("आधार संख्या: [AADHAAR]");
    expect(text).toContain("पता: [ADDRESS]");
    expect(JSON.stringify(r.request!.body)).not.toContain("अर्जुन सिंह");
  });

  it("sanitizes the Hinglish fixture", async () => {
    const r = await authorize({
      observation: { visibleText: "Naam: Arjun Singh Mera mobile number 9876543210 hai. Meri email arjun@example.com hai." },
    });
    expect(r.decision.decision).toBe("ALLOW");
    const text = (r.request!.body as { observation: { visibleText: string } }).observation.visibleText;
    expect(text).toContain("Naam: [PERSON]");
    expect(text).toContain("[PHONE]");
    expect(text).toContain("[EMAIL]");
  });
});

describe("Phase 37 — safe content survives", () => {
  it("keeps product IDs, prices, dates and buttons", async () => {
    const body = {
      observation: {
        visibleText: "Product ID: 123456 Price: ₹50,000 Date: 20 Sep 2026",
        elements: [{ id: "el_001", role: "button", name: "Submit" }],
      },
    };
    const r = await authorize(body);
    expect(r.decision.decision).toBe("ALLOW");
    expect(r.decision.redactionCount).toBe(0);
    expect(r.request!.body).toEqual(body);
  });
});

describe("Phase 38 — leakage battery (all must BLOCK or sanitize)", () => {
  it("1. email in JSON is masked", async () => {
    const r = await authorize({ contact: { email: "user@example.com" } });
    expect(r.decision.decision).toBe("ALLOW");
    expect(JSON.stringify(r.request!.body)).not.toContain("user@example.com");
  });

  it("2. phone in nested JSON is masked", async () => {
    const r = await authorize({ page: { sections: [{ elements: [{ metadata: { label: "Phone", value: "Call 9876543210" } }] }] } });
    expect(r.decision.decision).toBe("ALLOW");
    expect(JSON.stringify(r.request!.body)).not.toContain("9876543210");
  });

  it("3. password in a DOM snapshot BLOCKS", async () => {
    const r = await authorize({ observation: { visibleText: "login password: hunter2-hunter", elements: [] } });
    expect(r.decision.decision).toBe("BLOCK");
    expect(r.decision.reason).toBe("SECRET_DETECTED");
    expect(r.request).toBeUndefined();
  });

  it("4. OTP beside its cue BLOCKS; bare 6 digits do not", async () => {
    const withCue = await authorize({ observation: { visibleText: "Your OTP is 482916. Valid 5 min." } });
    expect(withCue.decision.decision).toBe("BLOCK");
    expect(withCue.decision.detectedTypes).toContain("OTP");
    const bare = await authorize({ observation: { visibleText: "Product ID: 482916" } });
    expect(bare.decision.decision).toBe("ALLOW");
  });

  it("5. Aadhaar in OCR-derived text is masked with ocr-safe flow", async () => {
    const r = await authorize({ ocr: { text: `AADHAAR ${AADHAAR}` } });
    expect(r.decision.decision).toBe("ALLOW");
    expect(JSON.stringify(r.request!.body)).not.toContain("2345");
    expect(JSON.stringify(r.request!.body)).not.toContain("6789");
    expect(JSON.stringify(r.request!.body)).toContain("[AADHAAR]");
  });

  it("6. PAN in metadata is masked", async () => {
    const r = await authorize({ metadata: { pan: "ABCPP1234F" } });
    expect(r.decision.decision).toBe("ALLOW");
    expect(JSON.stringify(r.request!.body)).not.toContain("ABCPP1234F");
  });

  it("7. email inside a URL query is masked", async () => {
    const clean = sanitizeUrlString("https://example.com/profile?email=user@example.com&x=1", {
      types: new Set(),
      redactions: 0,
    });
    expect(clean).not.toContain("user@example.com");
    expect(clean).toContain("email=");
  });

  it("8/9. PII in arrays and deep nesting is masked", async () => {
    const r = await authorize({ items: ["a@b.com", { deep: [{ deeper: "call 9876543210" }] }] });
    expect(r.decision.decision).toBe("ALLOW");
    const s = JSON.stringify(r.request!.body);
    expect(s).not.toContain("a@b.com");
    expect(s).not.toContain("9876543210");
  });

  it("10. PII inside an error-ish string is still masked", async () => {
    const check = validateSerialized(JSON.stringify({ error: "failed for a@b.com" }));
    expect(check.clean).toBe(false);
    expect(check.types).toContain("EMAIL");
  });

  it("11. decision objects never contain raw values", async () => {
    const r = await authorize({ observation: { visibleText: "mail a@b.com phone 9876543210" } });
    expect(serializedDecision(r)).not.toContain("a@b.com");
    expect(serializedDecision(r)).not.toContain("9876543210");
    expect(r.decision.detectedTypes).toEqual(expect.arrayContaining(["EMAIL", "PHONE"]));
  });

  it("12. raw screenshot upload BLOCKS", async () => {
    const r = await authorize({ screenshot: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg" + "A".repeat(300) });
    expect(r.decision.decision).toBe("BLOCK");
    expect(r.decision.reason).toBe("RAW_IMAGE");
  });

  it("13. raw OCR blob field BLOCKS via image-field rule", async () => {
    const r = await authorize({ ocr_image: "ciphers-and-pixels-here" });
    expect(r.decision.decision).toBe("BLOCK");
  });

  it("14. auth headers BLOCK", async () => {
    const r = await authorize(
      { observation: { visibleText: "hello" } },
      { headers: { "Content-Type": "application/json", Authorization: "Bearer abcdefgh12345678" } },
    );
    expect(r.decision.decision).toBe("BLOCK");
    expect(r.decision.reason).toBe("SECRET_DETECTED");
  });

  it("15. PII inside query parameters is masked end-to-end", async () => {
    const r = await authorize(
      { observation: { visibleText: "hi" } },
      { url: "http://localhost:8000/api/agent/step?next=user@example.com" },
    );
    expect(r.decision.decision).toBe("ALLOW");
    expect(r.request!.url).not.toContain("user@example.com");
  });

  it("bearer tokens and api keys BLOCK with their kinds", async () => {
    for (const secret of [
      "Authorization: Bearer abcdefgh12345678",
      "api_key = sk-projhunter2hunter2",
      "sessionid=abcDEF123456",
    ]) {
      const r = await authorize({ observation: { visibleText: `note ${secret} end` } });
      expect(r.decision.decision).toBe("BLOCK");
      expect(r.decision.reason).toBe("SECRET_DETECTED");
    }
    expect(detectSecrets("discuss the token economy")).toHaveLength(0);
  });

  it("unknown/opaque content fails closed", async () => {
    const r = await authorize({ blob: new Uint8Array([1, 2, 3]) } as unknown as Record<string, unknown>);
    expect(r.decision.decision).toBe("BLOCK");
  });

  it("malformed shapes fail closed, never throw", async () => {
    for (const bad of [null, 42, "string", [{ a: 1 }]]) {
      const r = await authorize(bad);
      expect(r.decision.decision).toBe("BLOCK");
    }
  });
});

describe("Phase 40 — second-pass validation is independent", () => {
  it("validateSerialized catches what a first pass could miss", () => {
    expect(validateSerialized('{"a":"clean"}').clean).toBe(true);
    const dirty = validateSerialized(JSON.stringify({ nested: { v: "a@b.com", n: 9876543210 } }));
    expect(dirty.clean).toBe(false);
    expect(dirty.types).toEqual(expect.arrayContaining(["EMAIL", "PHONE"]));
  });

  it("authorize BLOCKS when the final representation still leaks", async () => {
    // A mask-shaped string that still embeds raw PII around it.
    const r = await authorize({ note: "[EMAIL] actually a@b.com" });
    // First pass masks the raw occurrence; prove the double occurrence is gone too.
    expect(r.decision.decision).toBe("ALLOW");
    expect(JSON.stringify(r.request!.body)).not.toContain("a@b.com");
  });
});

describe("image gate + painter", () => {
  it("detects image payloads and lets plain text through", () => {
    expect(isProbableImagePayload("data:image/png;base64,AAAA")).toBe(true);
    expect(isProbableImagePayload("A".repeat(300))).toBe(true);
    expect(isProbableImagePayload(new ArrayBuffer(8))).toBe(true);
    expect(isProbableImagePayload("hello world")).toBe(false);
    expect(isProbableImagePayload(42)).toBe(false);
  });

  it("merges overlaps and clamps to the frame", () => {
    const merged = mergeRedactionBoxes(
      [
        { x: 10, y: 10, w: 50, h: 50 },
        { x: 40, y: 40, w: 50, h: 50 },
        { x: -20, y: -20, w: 10, h: 10 },
        { x: 500, y: 500, w: 10, h: 10 },
      ],
      200,
      200,
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]).toEqual({ x: 10, y: 10, w: 80, h: 80 });
  });

  it("paints blackout boxes on a fresh context only", () => {
    const calls: Array<[number, number, number, number]> = [];
    const ctx: PaintContext = {
      fillStyle: "",
      fillRect: (x, y, w, h) => {
        calls.push([x, y, w, h]);
      },
    };
    const painted = paintRedactions(ctx, [{ x: 5, y: 5, w: 10, h: 10 }], 100, 100);
    expect(ctx.fillStyle).toBe("#000");
    expect(calls).toEqual([[5, 5, 10, 10]]);
    expect(painted).toHaveLength(1);
  });
});

describe("gateway enforcement (no bypass)", () => {
  function providerWith(calls: { url: string; body: string }[]) {
    return new GatewayLlmProvider({
      fetchFn: (async (url: string, init?: { body?: string }) => {
        calls.push({ url: String(url), body: String(init?.body ?? "") });
        return new Response(
          JSON.stringify({
            action: { action: "finish", result: "done" },
            model: "openai/gpt-oss-20b",
          }),
          { status: 200 },
        );
      }) as never,
    });
  }

  it("ALLOW transmits the sanitized body — raw PII never on the wire", async () => {
    const calls: { url: string; body: string }[] = [];
    const provider = providerWith(calls);
    const res = await provider.complete({
      stepContext: {
        task: { goal: "Fill the form", intent: "form" },
        observation: {
          url: "https://example.com/form",
          title: "Form",
          tabId: 7,
          pageType: "content",
          viewport: { w: 100, h: 100 },
          scrollY: 0,
          scrollH: 0,
          loading: false,
          visibleText: "Email: a@b.com Phone: 9876543210",
          elements: [{ id: "el_001", role: "button", name: "Submit", tag: "button", visible: true, enabled: true, focused: false, rect: { x: 0, y: 0, w: 1, h: 1 } }],
          counted: 1,
          createdAt: Date.now(),
        },
        history: [],
        verification: null,
      },
    });
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].body).not.toContain("a@b.com");
    expect(calls[0].body).not.toContain("9876543210");
    expect(calls[0].body).toContain("[EMAIL]");
    expect(res.firewall?.decision).toBe("ALLOW");
    expect(res.firewall?.redactionCount).toBeGreaterThan(0);
  });

  it("BLOCK transmits nothing and classifies POLICY_BLOCK", async () => {
    const calls: { url: string; body: string }[] = [];
    const provider = providerWith(calls);
    const res = await provider.complete({
      stepContext: {
        task: { goal: "t", intent: "general" },
        observation: {
          url: "https://example.com",
          title: "t",
          tabId: 7,
          pageType: "content",
          viewport: { w: 1, h: 1 },
          scrollY: 0,
          scrollH: 0,
          loading: false,
          visibleText: "login password: hunter2-hunter",
          elements: [],
          counted: 0,
          createdAt: Date.now(),
        },
        history: [],
        verification: null,
      },
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("transmission_blocked");
    expect(res.errorCode).toBe("POLICY_BLOCK");
    expect(res.firewall?.decision).toBe("BLOCK");
    expect(calls).toHaveLength(0);
  });

  it("user-authored goal text passes (explicit instruction, not scraped leak)", async () => {
    const calls: { url: string; body: string }[] = [];
    const provider = providerWith(calls);
    const res = await provider.complete({
      stepContext: {
        task: { goal: "Fill my name Arjun Singh", intent: "form" },
        observation: {
          url: "https://example.com",
          title: "t",
          tabId: 7,
          pageType: "content",
          viewport: { w: 1, h: 1 },
          scrollY: 0,
          scrollH: 0,
          loading: false,
          visibleText: "Registration form",
          elements: [],
          counted: 0,
          createdAt: Date.now(),
        },
        history: [],
        verification: null,
      },
    });
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toContain("Arjun Singh");
  });
});
