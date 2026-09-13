/* ------------------------------------------------------------------ *
 * Content-side privacy scan — runs the DOM privacy scanner against the
 * live page and returns viewport-relative signals (no raw values).
 * ------------------------------------------------------------------ */

import { scanDomPrivacy, type DomPrivacyScan } from "@/privacy/dom-scanner";

export function scanPageDom(): DomPrivacyScan {
  return scanDomPrivacy(document);
}