/* ------------------------------------------------------------------ *
 * redaction.ts — canonical redaction entry point (Phase 4 layout).
 *
 * This module does NOT implement a second pipeline. It re-exports the
 * single Phase 3 composition in dependency order:
 *
 *   policy → planner → renderer → manifest → verifier → artifact
 *
 * Import from here (or @/privacy) when wiring the pipeline; import the
 * focused modules only when unit-testing one stage in isolation.
 * ------------------------------------------------------------------ */

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
  RawCapture,
  SanitizedImage,
  SanitizeError,
  isSealedSanitizedImage,
  sanitizeImage,
  type SanitizeOptions,
  type SanitizeResult,
} from "./sanitized-image";
