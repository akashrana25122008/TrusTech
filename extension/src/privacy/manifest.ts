/* ------------------------------------------------------------------ *
 * manifest.ts — canonical manifest entry point (Phase 4 layout).
 *
 * Re-exports the single manifest implementation. The manifest is built
 * ONLY from renderer-applied operations (buildManifest) and validated
 * at the gate and the server (validateRedactionManifest). No parallel
 * manifest representation exists.
 * ------------------------------------------------------------------ */

export {
  REDACTION_MANIFEST_VERSION,
  buildManifest,
  validateRedactionManifest,
  manifestsEqual,
  type RedactionManifest,
  type RedactionManifestRegion,
  type ManifestValidation,
} from "./redaction-manifest";
