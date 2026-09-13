/* ------------------------------------------------------------------ *
 * verifier.ts — canonical verification entry point (Phase 4 layout).
 *
 * Re-exports the single pixel-verification implementation. Verification
 * answers one question with pixels, not metadata: did the exported
 * image actually change exactly where the manifest says, and nowhere
 * else? Any failure blocks transmission (fail closed).
 * ------------------------------------------------------------------ */

export {
  verifyRedaction,
  type VerificationCheck,
  type PixelVerification,
} from "./pixel-verify";
