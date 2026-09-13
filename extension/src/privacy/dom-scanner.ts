/* ------------------------------------------------------------------ *
 * DOM privacy scanner — extracts password fields + text PII signals
 * from a live DOM tree (content script) or a jsdom Document (tests).
 *
 * Operates in TWO passes:
 *   1. Structural: input[type=password], textarea (PASSWORD)
 *   2. Textual: all visible text-bearing leaf elements → run through the
 *      existing Indian/full PII engine (provenance dom-text / field-*).
 *
 * Coordinates are viewport-relative (getBoundingClientRect).
 * Canonical-image mapping happens in privacy-analyzer via coords.ts.
 * No sensitive values are ever included in the output signals — only
 * the canonical type, bounding box, and detector name.
 * ------------------------------------------------------------------ */

import { scanSources, type PiiProvenance } from "./fusion";
import { findingToSensitive, MIN_REGION_CONFIDENCE, type SensitiveType, type RegionBBox } from "./regions";

/* ------------------------------------------------------------------ *
 * Viewport dimensions (injected for deterministic tests)
 * ------------------------------------------------------------------ */

export interface DomViewport {
  width: number;
  height: number;
}

function readViewport(doc: Document): DomViewport {
  try {
    const w = doc.defaultView;
    if (w) return { width: w.innerWidth, height: w.innerHeight };
  } catch {
    /* noop */
  }
  return { width: 0, height: 0 };
}

/* ------------------------------------------------------------------ *
 * Element visibility (works in jsdom — no layout APIs needed)
 * ------------------------------------------------------------------ */

function isVisible(el: Element): boolean {
  if (el.hasAttribute("hidden")) return false;
  if (el.getAttribute("aria-hidden") === "true") return false;
  const tag = el.tagName.toLowerCase();
  if (tag === "script" || tag === "style" || tag === "noscript" || tag === "template" || tag === "svg") return false;

  try {
    const style = (el as HTMLElement).style;
    if (style?.display === "none" || style?.visibility === "hidden" || style?.opacity === "0") return false;
  } catch {
    /* noop */
  }
  return true;
}

function hasVisibleRect(rect: RegionBBox): boolean {
  return rect.width > 0 && rect.height > 0;
}

/* ------------------------------------------------------------------ *
 * Password field context cues
 * ------------------------------------------------------------------ */

const PASSWORD_CUES = [
  "password",
  "passwd",
  "pwd",
  "passkey",
  "पासवर्ड",
  "पासवर्ड",
  "कूटशब्द",
  "parola",
  "kennwort",
];

/* ------------------------------------------------------------------ *
 * DOM scan
 * ------------------------------------------------------------------ */

export interface DomPrivacyScan {
  viewport: DomViewport;
  /** Normalized scan summary. */
  signals: DomSignal[];
  scanned: number;
  domScanMs: number;
}

export interface DomSignal {
  type: SensitiveType;
  bbox: RegionBBox;
  confidence: number;
  source: "dom" | "text";
  detector: string;
  pattern?: string;
  contextLabel?: string;
  coordinateSystem: "viewport";
}

export interface DomScannerOptions {
  /** Document root to scan. Defaults to the passed-in root's ownerDocument or root itself. */
  root?: Document | Element;
  /** Override viewport for deterministic testing. */
  viewport?: DomViewport;
  /** Maximum elements to scan (performance cap). */
  maxElements?: number;
  /** Maximum text per element before truncation. */
  maxTextPerElement?: number;
  /** Minimum confidence to emit a signal. */
  minConfidence?: number;
  /**
   * Inject getBoundingClientRect for testing (jsdom has no layout).
   * In production, pass undefined to use the real API.
   */
  readRect?: (el: Element) => RegionBBox;
  /**
   * Inject a custom visibility test (defaults to the built-in).
   */
  isVisible?: (el: Element) => boolean;
}

/**
 * Run a full DOM privacy scan on a Document or root element.
 * Returns signals with viewport-relative bounding boxes.
 */
export function scanDomPrivacy(
  root: Document | Element,
  options: DomScannerOptions = {},
): DomPrivacyScan {
  // Tag-based/realm-agnostic Document|Element resolution (see isPasswordInput
  // for why instanceof-based branch logic needs explicit feature detection).
  const isDocument = typeof Document !== "undefined" && root instanceof Document;
  const isElement = typeof Element !== "undefined" && root instanceof Element;
  const doc: Document = isDocument ? root : isElement ? root.ownerDocument! : (root as Document);
  const viewport = options.viewport ?? readViewport(doc);
  const readRect = options.readRect ?? defaultReadRect;
  const visibleTest = options.isVisible ?? isVisible;
  const maxElements = options.maxElements ?? 2000;
  const maxText = options.maxTextPerElement ?? 2000;
  const minConf = options.minConfidence ?? MIN_REGION_CONFIDENCE;
  const startTime = performance.now();
  const signals: DomSignal[] = [];
  const seenText = new Set<string>();
  let scanned = 0;

  // Collect all elements; cap before the iteration.
  const all = root.querySelectorAll("*");
  const len = Math.min(all.length, maxElements);

  for (let i = 0; i < len; i++) {
    const el = all[i];
    if (!visibleTest(el)) continue;
    const rect = readRect(el);
    if (!hasVisibleRect(rect)) continue;
    scanned++;

    // ---- Pass 1: Structural password fields ----
    // Tag-name based (NOT instanceof): Chrome content scripts run in an
    // isolated world, so page-DOM elements are not instanceof the content
    // script's HTMLInputElement class.
    if (isPasswordInput(el)) {
      const cues = getLabelCuesFor(el, doc);
      const hasCue = cues.some((c) => PASSWORD_CUES.some((pc) => c.toLowerCase().includes(pc.toLowerCase())));
      signals.push({
        type: "PASSWORD",
        bbox: rect,
        confidence: hasCue ? 0.96 : 0.9,
        source: "dom",
        detector: "dom:input-password",
        pattern: "dom:input-type",
        contextLabel: cues.find((c) => PASSWORD_CUES.some((pc) => c.toLowerCase().includes(pc.toLowerCase()))) ?? undefined,
        coordinateSystem: "viewport",
      });
      continue; // password field value is never PII-scanned
    }

    // ---- Pass 2: Text PII in visible element text ----
    const text = getElementText(el, maxText);
    if (!text || text.length < 4) continue;
    const textKey = el.tagName + ":" + text;
    if (seenText.has(textKey)) continue;
    seenText.add(textKey);

    const provenance = getProvenanceForElement(el);
    const chunks = [{ text, provenance }];
    const findings = scanSources(chunks, { minConfidence: minConf });
    if (findings.length === 0) continue;

    for (const f of findings) {
      const type = findingToSensitive(f.type);
      if (!type) continue;
      signals.push({
        type,
        bbox: rect,
        confidence: f.confidence,
        source: "text",
        detector: "dom:text-" + f.provenance + ":" + type.toLowerCase(),
        pattern: f.provenance,
        contextLabel: f.contextLabel,
        coordinateSystem: "viewport",
      });
    }
  }

  return {
    viewport,
    signals,
    scanned,
    domScanMs: performance.now() - startTime,
  };
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function defaultReadRect(el: Element): RegionBBox {
  try {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  } catch {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
}

function getElementText(el: Element, maxText: number): string {
  // Form controls: use value / placeholder / aria-label / name.
  // Tag-based checks (see isPasswordInput): robust across realms.
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") {
    const input = el as HTMLInputElement;
    const parts: string[] = [];
    if (input.value) parts.push(input.value);
    if (input.placeholder) parts.push(input.placeholder);
    if (el.getAttribute("aria-label")) parts.push(el.getAttribute("aria-label")!);
    if (input.name) parts.push(input.name);
    return parts.join(" ").trim().slice(0, maxText);
  }
  if (tag === "SELECT") {
    const sel = el as HTMLSelectElement;
    return sel.options[sel.selectedIndex]?.text?.trim().slice(0, maxText) ?? "";
  }
  // For non-form elements: use only direct text nodes (leaf text).
  // This avoids scanning text twice when parent + child both appear in the
  // all-element list.
  const childElements = el.querySelectorAll("*");
  if (childElements.length > 0) return ""; // let the children handle their own text.
  const text = el.textContent?.trim().slice(0, maxText) ?? "";
  return text;
}

function getProvenanceForElement(el: Element): PiiProvenance {
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
    return (el as HTMLInputElement).value ? "field-value" : "field-label";
  }
  if (tag === "LABEL") return "field-label";
  const role = el.getAttribute("role");
  if (role === "textbox" || role === "searchbox" || role === "combobox") return "field-value";
  return "dom-text";
}

/**
 * Collect label/context cues associated with an input element.
 * Checks: htmlFor, wrapping label, aria-labelledby, aria-label, placeholder,
 * name, id (all values are cues, NOT the actual value the user typed).
 */
/**
 * Escape an element id for use inside a CSS selector (jsdom may skip
 * the global CSS.escape helper, so this is self-contained).
 */
function escapeCssId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

function isPasswordInput(el: Element): boolean {
  return el.tagName === "INPUT" && el.getAttribute("type")?.toLowerCase() === "password";
}

function getLabelCuesFor(el: Element, doc: Document): string[] {
  const input = el as HTMLInputElement;
  const cues: string[] = [];
  if (input.placeholder) cues.push(input.placeholder);
  if (el.getAttribute("aria-label")) cues.push(el.getAttribute("aria-label")!);
  if (input.name) cues.push(input.name);
  if (el.id) {
    const label = doc.querySelector(`label[for="${escapeCssId(el.id)}"]`);
    if (label) cues.push(label.textContent ?? "");
  }
  // Walk ancestors for label/fieldset/legend text.
  let parent: Element | null = el.parentElement;
  let depth = 0;
  while (parent && depth < 5) {
    if (parent.tagName === "LABEL") {
      cues.push(parent.textContent ?? "");
      break;
    }
    const legend = parent.querySelector("legend");
    if (legend) {
      cues.push(legend.textContent ?? "");
      break;
    }
    parent = parent.parentElement;
    depth++;
  }
  return cues.filter((c) => c.trim().length > 0);
}