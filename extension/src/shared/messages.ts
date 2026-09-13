/* ------------------------------------------------------------------ *
 * Messaging protocol between the three runtime realms:
 *
 *   panel/controller ─▶ background (service worker) ─▶ content script
 *      runtime.sendMessage                     tabs.sendMessage
 *
 * The content bridge (CTX_*) is a request/response RPC so the agent loop
 * can observe, ground and execute and then VERIFY against reality.
 * ------------------------------------------------------------------ */

import type { AgentAction, TargetSpec } from "./action-schema";

/* ------------------------- observation types ---------------------- */

export interface IndexedElement {
  id: string;
  role: string;
  name: string;
  tag: string;
  type?: string;
  visible: boolean;
  enabled: boolean;
  focused: boolean;
  checked?: boolean;
  selected?: boolean;
  /** Short label/content hint (capped). */
  text?: string;
  /** Current input value (editable/select), so the verifier can check typing. */
  value?: string;
  rect: { x: number; y: number; w: number; h: number };
}

export interface ObservationSnapshot {
  url: string;
  title: string;
  tabId: number;
  pageType: string;
  viewport: { w: number; h: number };
  scrollY: number;
  scrollH: number;
  loading: boolean;
  /** Compact visible text (capped) — never raw HTML. */
  visibleText: string;
  elements: IndexedElement[];
  counted: number;
  createdAt: number;
}

export interface GroundingResult {
  status: "ok" | "not_found" | "hidden" | "disabled" | "ambiguous";
  elementId?: string;
  method?: "id" | "role+name" | "text" | "selector";
  reason?: string;
}

export interface ActionResult {
  ok: boolean;
  error?: string;
  details?: string;
  /** Hints the verifier can check against reality. */
  hint?: {
    url?: string;
    value?: string;
    text?: string;
    selected?: string;
    checked?: boolean;
  };
}

/* ----------------------- content bridge (RPC) ---------------------- */

export interface CtxObserveRequest {
  type: "CTX_OBSERVE";
}
export interface CtxObserveResponse {
  type: "CTX_OBSERVE_RESULT";
  payload: ObservationSnapshot;
}

export interface CtxGroundRequest {
  type: "CTX_GROUND";
  payload: { target: TargetSpec };
}
export interface CtxGroundResponse {
  type: "CTX_GROUND_RESULT";
  payload: GroundingResult;
}

export interface CtxExecuteRequest {
  type: "CTX_EXECUTE";
  payload: { action: AgentAction; groundedId?: string };
}
export interface CtxExecuteResponse {
  type: "CTX_EXECUTE_RESULT";
  payload: ActionResult;
}

export interface CtxSetDomainRequest {
  type: "CTX_SET_DOMAIN";
  payload: { domain: string };
}
export interface CtxSetDomainResponse {
  type: "CTX_SET_DOMAIN_RESULT";
  payload: { ok: boolean };
}

/** Panel → content: ground a vision_step point to a live element and click it. */
export interface CtxVisionPointRequest {
  type: "CTX_VISION_POINT";
  payload: {
    point: { x: number; y: number };
    image: { width: number; height: number };
    confidence?: number;
    bbox?: { x: number; y: number; width: number; height: number };
    normalized?: { x: number; y: number; width: number; height: number };
    coordinateSpace?: "screenshot_pixels" | "viewport_css" | "page_css" | "device_pixels";
    viewport?: { width: number; height: number };
    dpr?: number;
    scroll?: { x: number; y: number };
    crop?: { x: number; y: number };
    captureId?: string;
    capturedAt?: number;
    url?: string;
    label?: string;
  };
}
export interface CtxVisionPointResponse {
  type: "CTX_VISION_POINT_RESULT";
  payload: {
    ok: boolean;
    viewport?: { x: number; y: number };
    grounding?: { status: string; elementId?: string; method?: string; reason?: string };
    execution?: ActionResult;
    error?: string;
  };
}

/** Panel → content: scan the live page DOM for privacy signals (Phase 2). */
export interface CtxPrivacyScanRequest {
  type: "CTX_PRIVACY_SCAN";
  payload?: { minConfidence?: number };
}
/** Content → panel: viewport-relative DOM privacy scan result. */
export interface CtxPrivacyScanResponse {
  type: "CTX_PRIVACY_SCAN_RESULT";
  payload: import("@/privacy/dom-scanner").DomPrivacyScan;
}

export type ContentRequest =
  | CtxObserveRequest
  | CtxGroundRequest
  | CtxExecuteRequest
  | CtxSetDomainRequest
  | CtxPrivacyScanRequest
  | CtxPingRequest;

export type ContentResponse =
  | CtxObserveResponse
  | CtxGroundResponse
  | CtxExecuteResponse
  | CtxVisionPointResponse
  | CtxSetDomainResponse
  | CtxPrivacyScanResponse
  | CtxPongResponse
  | InjectActionResultResponse;

/** content → background push: observable reality changed. */
export interface PageChangedMessage {
  type: "PAGE_CHANGED";
  payload: { kind: "mutation" | "navigation" | "scroll" | "visibility"; url?: string };
}

/* ------------------------- content handshake ---------------------- */

/** background → content: connectivity probe before an action. */
export interface CtxPingRequest {
  type: "CTX_PING";
}
/** content → background: the bridge is alive and can answer. */
export interface CtxPongResponse {
  type: "CTX_PONG";
  payload: { ok: true; url: string };
}

/** content → background: bridge initialised (after load/navigation). */
export interface ContentReadyMessage {
  type: "CONTENT_READY";
  payload: { kind: "load" | "navigation" | "reconnect"; url: string };
}

/** content → background: a dock-injected page action was performed. */
export interface InjectActionResultResponse {
  type: "AGENT_INJECT_ACTION_RESULT";
  payload: { ok: true };
}

/** Final consumer-facing reason for why a page could not be driven. */
export type ContentErrorCode =
  | "unsupported_page"
  | "content_script_not_ready"
  | "no_active_tab"
  | "no_extension";

/** Error envelope embedded in a CTX_*_RESULT reply when routing fails. */
export interface ContentErrorReply {
  error: ContentErrorCode;
  message?: string;
}

/** background → panel relay of page changes. */
export interface EventPageChangedMessage {
  type: "EVENT_PAGE_CHANGED";
  payload: PageChangedMessage["payload"];
}

/** background → panel: content bridge became ready on a tab. */
export interface EventContentReadyMessage {
  type: "EVENT_CONTENT_READY";
  payload: { tabId: number };
}

/** Panel → background tab-bounding commands (kept from v1). */
export interface BrowserCommandMessageV2Payload {
  command: "newTab" | "newWindow" | "switchTab" | "closeTab" | "reload" | "back" | "forward" | "navigate";
  /** Explicit target tab. When omitted the background resolves the active tab. */
  tabId?: number;
  url?: string;
}

export type PanelBusRequest =
  | { type: "CTX_OBSERVE" }
  | { type: "CTX_GROUND"; payload: { target: TargetSpec } }
  | { type: "CTX_EXECUTE"; payload: { action: AgentAction; groundedId?: string } }
  | { type: "CTX_VISION_POINT"; payload: CtxVisionPointRequest["payload"] }
  | { type: "BROWSER_COMMAND"; payload: BrowserCommandMessageV2Payload };

export type PanelBusResponse =
  | CtxObserveResponse
  | CtxGroundResponse
  | CtxExecuteResponse
  | { type: "BROWSER_COMMAND_RESULT"; payload: { ok: boolean } };