import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "pii.json");

function item(id, text, spans, group = "clear", note = "") {
  const entities = spans.map(([substr, type, extra = {}]) => {
    const start = text.indexOf(substr);
    if (start < 0) throw new Error(`span ${substr} not found in ${id}`);
    return { type, start, end: start + substr.length, ...extra };
  });
  return { id, group, text, entities, note };
}

const clear = [
  item("pii-01", "Contact us at support@example.com for help", [["support@example.com", "email"]]),
  item("pii-02", "Call +91 98765 43210 today", [["+91 98765 43210", "phone"]]),
  item("pii-03", "my number is 98765 43210", [["98765 43210", "phone"]]),
  item("pii-04", "Aadhaar 2345 6789 0124 submitted", [["2345 6789 0124", "aadhaar"]]),
  item("pii-05", "PAN ABCAP1234F issued", [["ABCAP1234F", "pan"]]),
  item("pii-06", "card 4111 1111 1111 1111 charged", [["4111 1111 1111 1111", "credit_card"]]),
  item("pii-07", "card 4111-1111-1111-1111 charged", [["4111-1111-1111-1111", "credit_card"]]),
  item("pii-08", "pay to me@okhdfcbank now", [["me@okhdfcbank", "upi"]]),
  item("pii-09", "IFSC HDFC0000267 confirmed", [["HDFC0000267", "ifsc"]]),
  item("pii-10", "passport A1234567 ready", [["A1234567", "passport"]]),
  item("pii-11", "voter ABC1234567 listed", [["ABC1234567", "voter_id"]]),
  item("pii-12", "DL KA01 12345678901 valid", [["KA01 12345678901", "driving_licence"]]),
  item("pii-13", "SSN 123-45-6789 here", [["123-45-6789", "ssn"]]),
  item("pii-14", "server at 192.168.1.1 ok", [["192.168.1.1", "ipv4"]]),
  item("pii-15", "PIN code 560001 area", [["560001", "postal"]]),
  item("pii-16", "reach me@example.com or +91 98765 43210", [["me@example.com", "email"], ["+91 98765 43210", "phone"]]),
  item("pii-17", "कार्ड 4111 1111 1111 1111 शुल्क", [["4111 1111 1111 1111", "credit_card"]]),
  item("pii-18", "Call support at 12345", []),
  item("pii-19", "Order 482915, total 1299", []),
  item("pii-20", "Meeting on 31 July 2026", []),
  item("pii-21", "phone 98765", []),
  item("pii-22", "id ABC12", []),
  item("pii-23", "passport a1234567", []),
  item("pii-24", "voter abc1234567", []),
  item("pii-25", "amount 85000 only", []),
  item("pii-26", "asus rog 123456", []),
  item("pii-27", "The event starts at 10am sharp", []),
  item("pii-28", "Verification code 482915", []),
  item("pii-29", "OTP 482915 expired", []),
];

const ambiguous = [
  item("pii-a1", "Aadhaar 234567890125", [["234567890125", "aadhaar"]], "ambiguous",
    "Invalid Verhoeff checksum, but the engine emits a weak finding by design; tracked separately, excluded from headline precision."),
  item("pii-a2", "num 298765432109", [["298765432109", "aadhaar"]], "ambiguous",
    "No context cue; weak 0.55 finding by design; tracked separately."),
  item("pii-a3", "email me@example", [["me@example", "upi"]], "ambiguous",
    "Dotless handle matches the UPI rule, not the email rule; engine behavior by design; tracked separately."),
];

const doc = {
  version: 1,
  notes: [
    "Ground truth for TrusTech's PII fusion engine (FindingType level).",
    "CLEAR group feeds headline precision/recall. AMBIGUOUS group is measured and reported separately: the engine intentionally emits weak findings for these shapes.",
    "Matching rule: same type with character-span IoU >= 0.5 (tolerant to separator inclusion).",
    "Categories without detector support (api keys, auth tokens as PII findings) are out of scope: INSUFFICIENT DATA, covered by the secrets firewall instead.",
    "All values are synthetic.",
  ],
  items: [...clear, ...ambiguous],
};

writeFileSync(OUT, JSON.stringify(doc, null, 2) + "\n");
console.log(`wrote ${doc.items.length} items to ${OUT}`);
