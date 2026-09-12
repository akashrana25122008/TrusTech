/* ------------------------------------------------------------------ *
 * Secret detectors — authentication material that must NEVER leave
 * the device inside page-derived context: passwords, OTPs, tokens,
 * API keys, cookies, auth headers, private keys.
 *
 * Hits carry spans + kinds only; the firewall masks by span and the
 * decision object never contains values.
 * ------------------------------------------------------------------ */

import type { SecretKind } from "./policy";

export interface SecretHit {
  kind: SecretKind;
  /** Span in the scanned (original) string. */
  start: number;
  end: number;
  confidence: number;
}

interface Pattern {
  kind: SecretKind;
  re: RegExp;
  confidence: number;
}

const PATTERNS: readonly Pattern[] = [
  // password= / passwd: <value> assignments (value never captured outward).
  { kind: "PASSWORD", re: /\b(passwou?rd|passwd|pwd|passphrase)\b\s*[:=]\s*\S+/gi, confidence: 0.95 },
  // Bearer / Basic auth material.
  { kind: "TOKEN", re: /\bbearer\s+[A-Za-z0-9\-._~+/=]{16,}\b/gi, confidence: 0.95 },
  { kind: "TOKEN", re: /\bbasic\s+[A-Za-z0-9+/=]{16,}={0,2}\b/gi, confidence: 0.9 },
  // API keys in known shapes.
  { kind: "API_KEY", re: /\bsk-[A-Za-z0-9]{16,}\b/g, confidence: 0.95 },
  { kind: "API_KEY", re: /\bAKIA[0-9A-Z]{16}\b/g, confidence: 0.95 },
  { kind: "API_KEY", re: /\b(ghp|gho|github_pat)_[A-Za-z0-9]{16,}\b/g, confidence: 0.95 },
  { kind: "API_KEY", re: /\bxox[bpas]-[A-Za-z0-9\-]{10,}\b/gi, confidence: 0.95 },
  { kind: "API_KEY", re: /\bAIza[0-9A-Za-z\-_]{30,}\b/g, confidence: 0.9 },
  { kind: "API_KEY", re: /\b(api[_-]?key|apikey)\b\s*[:=]\s*["']?[A-Za-z0-9\-._~+/=]{12,}["']?/gi, confidence: 0.9 },
  // Generic token assignments with token-shaped values.
  { kind: "TOKEN", re: /\b(token|auth[_-]?token|access[_-]?token|session[_-]?token|secret)\b\s*[:=]\s*["']?[A-Za-z0-9\-._~+/=]{16,}["']?/gi, confidence: 0.9 },
  // Session cookies.
  { kind: "COOKIE", re: /\b(sessionid|sessid|sid|session[_-]?id|phpsessid|jsessionid)\s*=\s*[A-Za-z0-9\-._~+/=]{8,}/gi, confidence: 0.9 },
  // PEM private keys.
  { kind: "API_KEY", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, confidence: 0.99 },
];

const OTP_CUES = ["otp", "one-time", "one time", "verification code", "ओटीपी", "सत्यापन"];
const OTP_RE = /(?<!\d)(\d{4,8})(?!\d)/g;

/** Scan text for secret material. Pure function, no I/O. */
export function detectSecrets(text: string): SecretHit[] {
  const hits: SecretHit[] = [];
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = p.re.exec(text)) !== null) {
      if (m[0].length === 0) {
        p.re.lastIndex++;
        continue;
      }
      hits.push({ kind: p.kind, start: m.index, end: m.index + m[0].length, confidence: p.confidence });
    }
  }
  // OTP digits count ONLY beside an explicit OTP cue (bare 6-digit runs
  // are postal codes, not secrets).
  const lower = text.toLowerCase();
  if (OTP_CUES.some((cue) => lower.includes(cue))) {
    OTP_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = OTP_RE.exec(text)) !== null) {
      hits.push({ kind: "OTP", start: m.index, end: m.index + m[0].length, confidence: 0.85 });
    }
  }
  return hits.sort((a, b) => a.start - b.start);
}

/** True when a header name carries authentication material. */
export function isAuthHeader(name: string): boolean {
  const n = name.trim().toLowerCase();
  return n === "authorization" || n === "proxy-authorization" || n === "cookie" || n === "set-cookie";
}
