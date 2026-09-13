/* ------------------------------------------------------------------ *
 * TrusTech in-page agent runtime.
 *  - Renders the visual layer (marker, label, beam, status pill).
 *  - Wires the content bridge: CTX_OBSERVE / CTX_GROUND / CTX_EXECUTE
 *    RPC against the live DOM, plus PAGE_CHANGED push signals.
 *  - Content-ready handshake: CONTENT_READY on init / navigation so the
 *    background knows this bridge is live before messaging it.
 *  - CTX_PING / CTX_PONG for the background connectivity probe.
 * All extension API access goes through the shared runtime seam.
 * ------------------------------------------------------------------ */

import { AgentOverlay } from "./overlay";
import { executeAction, performAction, type PageAction } from "./executor";
import { PageObserver } from "./observer";
import { groundTarget } from "./grounder";
import { scanPageDom } from "./privacy";
import { groundVisionPoint } from "./vision-bridge";
import { rawApi } from "@/shared/runtime";
import type { ContentRequest, ContentResponse, PageChangedMessage, ContentReadyMessage } from "@/shared/messages";

const overlay = new AgentOverlay();

/* ------------------------------------------------------------------ *
 * content-ready handshake — tells the background "I am alive on this
 * tab" so it never attempts tabs.sendMessage on a cold tab again.
 * ------------------------------------------------------------------ */

function sendContentReady(kind: ContentReadyMessage["payload"]["kind"] = "load"): void {
  const msg = {
    type: "CONTENT_READY",
    payload: { kind, url: location.href },
  } satisfies ContentReadyMessage;
  try {
    rawApi().runtime?.sendMessage?.(msg, () => {
      // Read lastError so Chrome does not log "Unchecked runtime.lastError"
      void rawApi().runtime?.lastError;
    });
  } catch {
    // Non-extension context (e.g. vite dev) — ignore silently.
  }
}

/* ------------------------------------------------------------------ *
 * Page observer → PAGE_CHANGED push signals
 * ------------------------------------------------------------------ */

const pageObserver = new PageObserver((kind, url) => {
  const msg = { type: "PAGE_CHANGED", payload: { kind, url } } satisfies PageChangedMessage;
  try {
    rawApi().runtime?.sendMessage?.(msg, () => {
      void rawApi().runtime?.lastError;
    });
  } catch {
    /* noop */
  }
  // Re-announce the content bridge after an SPA navigation so the
  // background marks us as ready on the new history entry.
  if (kind === "navigation") sendContentReady("navigation");
});

/* ------------------------------------------------------------------ *
 * Content bridge RPC handler
 * ------------------------------------------------------------------ */

/**
 * Content bridge RPC handler. Returns true when the response is delivered
 * asynchronously (CTX_EXECUTE) so the message channel stays open until
 * sendResponse runs — otherwise MV3 closes the port and the execution
 * result is silently lost (the controller would see "no_response" for an
 * action that actually ran).
 */
export function handleMessage(
  message: ContentRequest | { type: string; payload?: Record<string, unknown> },
  _sender: unknown,
  sendResponse: (r: ContentResponse) => void,
): boolean | void {
  const payload = ((message as { payload?: unknown }).payload ?? {}) as Record<string, unknown>;
  switch (message.type) {
    case "CTX_PING":
      sendResponse({ type: "CTX_PONG", payload: { ok: true as const, url: location.href } });
      break;

    case "CTX_OBSERVE": {
      // Render-aware read: wait for DOM quiescence (bounded) so the
      // planner/verifier never decide on a half-painted page. Async
      // reply keeps the MV3 channel open until the settled snapshot
      // is delivered (same pattern as CTX_EXECUTE below).
      void pageObserver.settled(600, 2500).then(() => {
        const { snapshot } = pageObserver.observe();
        sendResponse({ type: "CTX_OBSERVE_RESULT", payload: snapshot });
      });
      return true;
    }
    case "CTX_GROUND": {
      sendResponse({ type: "CTX_GROUND_RESULT", payload: groundTarget(payload.target as never) });
      break;
    }
    case "CTX_EXECUTE": {
      const exPayload = payload as { action: Parameters<typeof executeAction>[0]; groundedId?: string };
      void executeAction(exPayload.action, exPayload.groundedId).then((result) => {
        pageObserver.invalidate();
        sendResponse({ type: "CTX_EXECUTE_RESULT", payload: result });
      });
      return true;
    }
    case "CTX_SET_DOMAIN": {
      pageObserver.start(-1);
      sendResponse({ type: "CTX_SET_DOMAIN_RESULT", payload: { ok: true } });
      break;
    }
    case "CTX_PRIVACY_SCAN": {
      sendResponse({ type: "CTX_PRIVACY_SCAN_RESULT", payload: scanPageDom() });
      break;
    }
    case "CTX_VISION_POINT": {
      const vpPayload = payload as unknown as import("./vision-bridge").VisionPointPayload;
      void groundVisionPoint(vpPayload).then((result) => {
        pageObserver.invalidate();
        sendResponse({ type: "CTX_VISION_POINT_RESULT", payload: result });
      });
      return true;
    }
    case "AGENT_HIGHLIGHT":
      overlay.highlight(
        (payload.kind as string) ?? "click",
        (payload.label as string) ?? "",
        payload.selector as string | undefined,
        payload.kind === "navigate",
      );
      break;
    case "AGENT_BEAM":
      overlay.beam.classList.toggle("on", Boolean(payload.on));
      break;
    case "AGENT_INJECT_ACTION": {
      const exPayload2 = payload as { command?: string; selector?: string; value?: string };
      const allowed = new Set<PageAction>(["click", "type", "scroll", "select", "back", "forward"]);
      if (allowed.has(exPayload2.command as PageAction)) {
        performAction(exPayload2.command as PageAction, exPayload2.selector, exPayload2.value);
        sendResponse({ type: "AGENT_INJECT_ACTION_RESULT", payload: { ok: true as const } });
      }
      break;
    }
    case "AGENT_STATE": {
      const status: string = (payload.status as string) ?? "";
      const dot = status === "ERROR" ? "blocked" : status === "IDLE" ? null : status;
      overlay.setState(dot ? `Agent · ${dot.toLowerCase()}` : null);
      break;
    }
    default:
      break;
  }
}

/* ------------------------------------------------------------------ *
 * Wire the listener and announce readiness
 * ------------------------------------------------------------------ */

const onMessage = rawApi().runtime?.onMessage;
if (onMessage?.addListener) {
  onMessage.addListener(handleMessage);
}

initialize();

function initialize(): void {
  pageObserver.start(-1);

  // Announce readiness once the document is stable. We announce both
  // immediately (to catch optimistic pings) and again on DOMContentLoaded
  // so the background has a fresh signal after a real page load.
  sendContentReady("load");

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => sendContentReady("load"), { once: true });
  } else {
    sendContentReady("load");
  }
}

/* On SPA navigations the host can survive; only re-install markers lazily. */
document.addEventListener("readystatechange", () => {
  if (document.readyState === "complete") {
    overlay.setState("Agent · ready");
    sendContentReady("reconnect");
  }
});

export {};