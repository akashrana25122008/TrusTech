/* ------------------------------------------------------------------ *
 * Outbound transmission policy — the centralized, typed, testable
 * statement of what may leave the device. No scattered if-statements:
 * every page-derived network request is judged against THIS policy.
 *
 * Provenance rule (design-critical):
 * - task.*            user-authored instruction → pattern-scan only
 *                      (the user asked the agent to use this data).
 * - observation.*,
 *   history, verification → page-derived → full rules (label-keyed
 *                      masking, cue masking, secret blocking).
 * ------------------------------------------------------------------ */

export type DataClassification = "SAFE" | "SENSITIVE" | "UNKNOWN";

export type SecretKind =
  | "PASSWORD"
  | "OTP"
  | "TOKEN"
  | "API_KEY"
  | "AUTH_HEADER"
  | "COOKIE";

export type FirewallReason =
  | "CLEAN"
  | "SANITIZED"
  | "SENSITIVE_DATA_REMAINING"
  | "SECRET_DETECTED"
  | "UNKNOWN_CONTENT"
  | "RAW_IMAGE"
  | "RAW_VALUE"
  | "SANITIZATION_FAILED"
  | "VALIDATION_FAILED"
  | "POLICY_DENIED"
  | "ENGINE_UNAVAILABLE";

/** Outbound placeholder masks (never reversible, never length-leaking). */
export const OUTBOUND_MASK: Record<string, string> = {
  PERSON: "[PERSON]",
  ADDRESS: "[ADDRESS]",
  PASSWORD: "[PASSWORD]",
  SECRET: "[SECRET]",
  OTP: "[OTP]",
  TOKEN: "[TOKEN]",
};

/** Payload paths treated as user-authored (pattern-scan only). */
export const USER_AUTHORDED_PATHS: readonly string[] = ["task"];

/** Element-descriptor keys: pattern-scan only, never label-key masking. */
export const DESCRIPTOR_KEYS: readonly string[] = ["id", "role", "name", "tag"];

/** Request headers the firewall ever forwards. */
export const ALLOWED_HEADERS: readonly string[] = ["content-type", "accept"];

/** Hard outbound size caps (larger bodies are rejected, not truncated). */
export const OUTBOUND_LIMITS = {
  bodyChars: 200_000,
  urlChars: 4_000,
  headerChars: 2_000,
  depth: 12,
} as const;

/* ---------------- sensitive field labels ---------------- */

function normKey(key: string): string {
  return key.trim().toLowerCase().replace(/[:_\-]+/g, " ").replace(/\s+/g, " ").trim();
}

const PERSON_KEYS = new Set([
  "name", "full name", "first name", "last name", "surname", "given name",
  "middle name", "username", "your name", "applicant name", "customer name",
  "naam", "pura naam", "pehla naam", "akhri naam", "upnaam",
  "नाम", "पूरा नाम", "पहला नाम", "अंतिम नाम", "उपनाम", "आपका नाम",
]);

const ADDRESS_KEYS = new Set([
  "address", "street", "city", "town", "village", "district", "pincode",
  "postal code", "zip code", "address line", "locality",
  "पता", "गली", "शहर", "गांव", "जिला", "पिन कोड", "डाक पता",
]);

const PASSWORD_KEYS = new Set([
  "password", "passwd", "pwd", "passcode", "pass phrase", "passphrase",
  "पासवर्ड", "कूटशब्द",
]);

const SECRET_KEYS = new Set([
  "otp", "otp code", "one time password", "verification code",
  "token", "auth token", "access token", "refresh token", "session token",
  "id token", "api key", "apikey", "api secret", "client secret",
  "secret", "session", "sessionid", "session id", "cookie", "auth",
  "authorization", "private key", "seed phrase", "recovery phrase",
  "ओटीपी", "सत्यापन कोड", "टोकन",
]);

export type SensitiveKeyCategory = "PERSON" | "ADDRESS" | "PASSWORD" | "SECRET" | null;

/** Classify a JSON key by its label. Descriptor keys are never sensitive. */
export function sensitiveKeyCategory(key: string): SensitiveKeyCategory {
  const n = normKey(key);
  if (PERSON_KEYS.has(n)) return "PERSON";
  if (ADDRESS_KEYS.has(n)) return "ADDRESS";
  if (PASSWORD_KEYS.has(n)) return "PASSWORD";
  if (SECRET_KEYS.has(n)) return "SECRET";
  return null;
}

/** UI/control tokens that must never be mistaken for a person's name. */
const UI_NAME_STOPLIST = new Set([
  "search", "submit", "button", "click", "menu", "home", "login", "signin",
  "sign in", "signup", "sign up", "more", "close", "open", "next", "back",
  "continue", "cancel", "save", "send", "go", "ok",
]);

const LATIN_NAME_SHAPE = /^[A-ZÀ-Þ][a-zà-þ]{1,30}(?:\s+[A-ZÀ-Þ][a-zà-þ]{1,30}){0,2}$/;
const DEVA_NAME_SHAPE = /^[\u0900-\u097F]{2,30}(?:\s+[\u0900-\u097F]{2,30}){0,2}$/;

/**
 * True when a value under a PERSON-labeled key actually looks like a
 * person's name (shape-gated so "Search"/"Submit" labels survive).
 */
export function looksLikePersonName(value: string): boolean {
  const v = value.trim();
  if (v.length < 2 || v.length > 80) return false;
  if (UI_NAME_STOPLIST.has(v.toLowerCase())) return false;
  return LATIN_NAME_SHAPE.test(v) || DEVA_NAME_SHAPE.test(v);
}

/** Values under ADDRESS-labeled keys are masked unless clearly a UI token. */
export function looksLikeAddress(value: string): boolean {
  const v = value.trim();
  if (v.length < 3 || v.length > 300) return false;
  return !UI_NAME_STOPLIST.has(v.toLowerCase());
}
