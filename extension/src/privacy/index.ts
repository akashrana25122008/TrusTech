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
  containsImagePayload,
  mergeRedactionBoxes,
  paintRedactions,
  type RedactionBox,
  type RedactionMethod as LegacyRedactionMethod,
  type PaintContext,
} from "./image";

/* ------------------- Phase 2 — visual privacy layer ------------------- */
export {
  type SensitiveType,
  type RegionSource,
  type RegionSeverity,
  type RegionBBox,
  type RegionSize,
  type RegionEvidence,
  type SensitiveRegion,
  type RegionCoordinateSystem,
  MIN_REGION_CONFIDENCE,
  STRONG_CONFIDENCE,
  WEAK_CONFIDENCE,
  MAX_FUSED_CONFIDENCE,
  SOURCE_RELIABILITY,
  FINDING_TO_SENSITIVE,
  findingToSensitive,
  baseSeverityFor,
  severityFor,
  TYPE_PRIORITY,
  typePriority,
  patternNameFor,
} from "./regions";
export {
  iouRect,
  regionsAligned,
  viewportToImage,
  imageToViewport,
  ocrToImage,
  scaledBBox,
  normalizeBBox,
  unionBBox,
  matchesGroundTruth,
  type ViewportScale,
  type OcRasterScale,
} from "./coords";
export {
  visionDetectionType,
  visionDetectionsToRegions,
} from "./vision-regions";
export {
  fuseSensitiveRegions,
  fuseRegionList,
  fuseConfidence,
  type CandidateRegion,
  type RegionFusionInput,
} from "./region-fusion";
export {
  scanDomPrivacy,
  type DomPrivacyScan,
  type DomSignal,
  type DomViewport,
  type DomScannerOptions,
} from "./dom-scanner";
export {
  ocrWordToRegions,
  ocrToCandidateRegions,
  type OcrProvider,
  type OcrResult,
  type OcrWord,
} from "./ocr";
export {
  analyzePrivacy,
  type PrivacyAnalysis,
  type PrivacyAnalysisInput,
  type PrivacyAnalysisMetrics,
  type PrivacyAnalysisStages,
} from "./privacy-analyzer";
export {
  decidePrivacy,
  type PrivacyAction,
  type PrivacyDecision,
} from "./decision";

/* ------------------- Phase 3 — visual redaction boundary ------------------- */
export {
  type RedactionMethod,
  REDACTION_METHODS,
  isRedactionMethod,
  METHOD_STRENGTH,
  methodStrength,
  type TypeRedactionRule,
  type RedactionPolicyConfig,
  DEFAULT_REDACTION_POLICY,
  ruleFor,
  resolveMethod,
  configurePolicy,
  isHighIdentity,
  isContactType,
} from "./redaction-policy";
export {
  planRedactions,
  type PixelBBox,
  type RedactionOperation,
  type DroppedRegion,
  type PlannedRedactions,
  type PlanImageSize,
} from "./redaction-planner";
export {
  renderRedactions,
  expectedMaskPixel,
  type RgbaSource,
  type AppliedOperation,
  type RenderOutput,
} from "./redaction-render";
export {
  REDACTION_MANIFEST_VERSION,
  buildManifest,
  validateRedactionManifest,
  manifestsEqual,
  type RedactionManifest,
  type RedactionManifestRegion,
  type ManifestValidation,
} from "./redaction-manifest";
export {
  verifyRedaction,
  type VerificationCheck,
  type PixelVerification,
} from "./pixel-verify";
export {
  RawCapture,
  SanitizedImage,
  SanitizeError,
  isSealedSanitizedImage,
  sanitizeImage,
  type SanitizeOptions,
  type SanitizeResult,
} from "./sanitized-image";
export {
  ImageTransmissionGate,
  buildImagePayload,
  IMAGE_PROTOCOL_ENDPOINT,
  type GateVerdict,
  type GateBlockCode,
  type GateResult,
  type ImageGateOptions,
  type SanitizedImagePayload,
} from "./image-gate";
export { encodePng, pngDataUrl } from "./png";

/* ------------------- Phase 4 — visual transmission ------------------- */
export {
  type VisionMetadata,
  type VisionMetadataInput,
  type MetadataValidation,
  buildVisionMetadata,
  validateVisionMetadata,
} from "./vision-metadata";
export {
  PERMIT_TTL_MS,
  isLivePermit,
  authorizeVisualTransmission,
  revalidatePermit,
  type TransmissionPermit,
  type PermitBlockCode,
  type PermitResult,
  type AuthorizeInput,
  type RevalidateInput,
} from "./transmission-permit";
export {
  type TaskPayload,
  type VisualContextPayload,
  type VisualTransmissionPayload,
  type PayloadValidation,
  validateTaskPayload,
  validateVisualPayload,
  buildVisualPayload,
  type TransportResponse,
  type VisualTransport,
  fetchTransport,
  assertSecureEndpoint,
  type TelemetryEventType,
  type TelemetryEvent,
  emitTelemetry,
  drainTelemetry,
  type TransmitBlockCode,
  type TransmitResult,
  type TransmitInput,
  transmitVisualContext,
  type RetryOptions,
  transmitWithRetry,
  type QueuedVisualItem,
  type QueueRejectCode,
  VisualTransmissionQueue,
} from "./visual-transmission";
export { sha256Hex, sha256Json, stableStringify, IntegrityError } from "./integrity";
export * from "./redaction";
export * from "./manifest";
export * from "./verifier";
