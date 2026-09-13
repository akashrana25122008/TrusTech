/* ------------------------------------------------------------------ *
 * Panel-side DOM privacy scan client — fetches viewport-relative
 * privacy signals from the content script via the background relay.
 * ------------------------------------------------------------------ */

import type { DomPrivacyScan } from "@/privacy/dom-scanner";

/**
 * Ask the content script on the active tab to scan the live DOM for
 * privacy signals (password fields, PII text). Returns the viewport-
 * relative signals, or null when the runtime is unavailable (dev preview)
 * or the request fails.
 */
export async function requestDomPrivacyScan(): Promise<DomPrivacyScan | null> {
  // Chrome namespace (callback-based); Firefox browser namespace (promise-based).
  const runtime: any =
    (typeof chrome !== "undefined" && chrome?.runtime) ||
    (typeof browser !== "undefined" && browser?.runtime) ||
    null;
  if (!runtime?.sendMessage) return null;

  return new Promise<DomPrivacyScan | null>((resolve) => {
    try {
      const result = runtime.sendMessage(
        { type: "CTX_PRIVACY_SCAN" },
        (response: unknown) => {
          // Chrome: lastError signals failure.
          if (runtime.lastError) return resolve(null);
          const payload = (response as Record<string, unknown>)?.payload;
          if (payload && typeof payload === "object" && "signals" in payload) {
            resolve(payload as DomPrivacyScan);
          } else {
            resolve(null);
          }
        },
      );
      // Firefox browser namespace returns a promise, not a callback.
      if (result && typeof result.then === "function") {
        result
          .then((resp: unknown) => {
            const payload = (resp as Record<string, unknown>)?.payload;
            if (payload && typeof payload === "object" && "signals" in payload) {
              resolve(payload as DomPrivacyScan);
            } else {
              resolve(null);
            }
          })
          .catch(() => resolve(null));
      }
    } catch {
      resolve(null);
    }
  });
}