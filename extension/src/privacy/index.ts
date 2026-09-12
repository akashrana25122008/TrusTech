/* ------------------------------------------------------------------ *
 * Privacy layer — PII detection, dynamic redaction, privacy firewall.
 *
 * Feature #1 (multilingual PII detection) public surface:
 * - scripts: Indic-script normalization with offset mapping
 * - india: checksum/context-validated Indian identifier detectors
 * - fusion: PII_FUSION pipeline → normalized PiiFinding records
 *   (the typed contract Feature #2 will consume)
 * ------------------------------------------------------------------ */

export { detectPii, redactPii, maskFor, type PiiMatch, type PiiRule, type PiiType } from "./detector";
export { PrivacyFirewall, type ScanResult, type RedactionEntry, type PrivacyVerdict, type PrivacyPolicy } from "./firewall";
export {
  normalizeForDetection,
  toOriginalSpan,
  detectScript,
  detectLanguage,
  type NormalizedText,
  type IndicScript,
  type LanguageHint,
} from "./scripts";
export {
  detectIndia,
  verhoeffValid,
  verhoeffCheckDigit,
  indiaContextBoost,
  phoneContextBoost,
  INDIA_CONTEXT,
  PHONE_CONTEXT,
  type IndiaHit,
  type IndiaPiiType,
} from "./india";
export {
  scanSources,
  scanText,
  scanVisualText,
  type PiiFinding,
  type FindingType,
  type TextChunk,
  type PiiProvenance,
  type VisualTextSource,
  type FusionOptions,
} from "./fusion";
export {
  validateSerialized,
  sanitizeUrlString,
  TransmissionFirewall,
  type FirewallVerdict,
  type FirewallDecision,
  type FirewallMetrics,
  type OutboundRequest,
  type SanitizedRequest,
  type AuthorizedTransmission,
} from "./transmission";
export {
  sensitiveKeyCategory,
  looksLikePersonName,
  looksLikeAddress,
  OUTBOUND_MASK,
  OUTBOUND_LIMITS,
  USER_AUTHORDED_PATHS,
  DESCRIPTOR_KEYS,
  ALLOWED_HEADERS,
  type DataClassification,
  type SecretKind,
  type FirewallReason,
  type SensitiveKeyCategory,
} from "./policy";
export { detectSecrets, isAuthHeader, type SecretHit } from "./secrets";
export {
  isProbableImagePayload,
  isImageFieldName,
  mergeRedactionBoxes,
  paintRedactions,
  type RedactionBox,
  type RedactionMethod,
  type PaintContext,
} from "./image";
