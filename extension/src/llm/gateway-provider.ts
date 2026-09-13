/* ------------------------------------------------------------------ *
 * GatewayLlmProvider — connects the extension runtime to the FastAPI
 * Groq gateway (POST /api/agent/step).
 *
 * Security & Boundary guarantees:
 * - NEVER contains or requires the API key (the key stays strictly
 *   in the backend environment).
 * - NEVER calls external reasoning endpoints directly; all traffic flows
 *   through the local/backend FastAPI gateway.
 * - All received actions must survive schema validation via
 *   validateAction() before being passed to the controller.
 * - Outbound observation data passes through privacy redaction before
 *   prompt creation.
 * ------------------------------------------------------------------ */

import type { GatewayErrorCode, LlmProvider, LlmRequest, LlmResponse } from "./llm-client";
import { validateAction } from "@/shared/action-schema";
import { TransmissionFirewall } from "@/privacy/transmission";
import type { TaskData, TaskStep } from "@/shared/types";

export interface GatewayProviderOptions {
  /** Backend base URL, e.g. "http://localhost:8000". */
  baseUrl?: string;
  /**
   * Optional bearer token for the local/backend gateway when it runs with
   * TRUSTECH_GATEWAY_TOKEN set. Extension-owned configuration (not
   * page-derived); attached to the outbound request AFTER the privacy
   * firewall authorizes the transmission. Never loaded from page data.
   */
  authToken?: string;
  /** Injectable fetch for testing and mocking. */
  fetchFn?: typeof fetch;
  /**
   * Request timeout in milliseconds (default: 60000ms). Must exceed the
   * backend's single-attempt Groq budget (30s) with margin, otherwise the
   * extension kills healthy-but-slow reasoning calls and misreports them
   * as timeouts while the backend may still succeed.
   */
  timeoutMs?: number;
  /** Health-check timeout in milliseconds (default: 2000ms). */
  healthTimeoutMs?: number;
  /**
   * Pre-network privacy firewall. Defaults to a real
   * TransmissionFirewall; pass null ONLY in tests that assert raw
   * transport behavior. Production traffic always passes authorization.
   */
  firewall?: TransmissionFirewall | null;
}

export interface BackendStepPayload {
  task: {
    goal: string;
    intent: string;
  };
  observation: {
    url: string;
    title: string;
    tabId: number;
    pageType: string;
    visibleText: string;
    elements: Array<{
      id?: string;
      role?: string;
      name?: string;
      tag?: string;
      [key: string]: unknown;
    }>;
  };
  history: string[];
  verification: Record<string, unknown> | null;
}

export class GatewayLlmProvider implements LlmProvider {
  readonly name = "groq-gateway";
  private baseUrl: string;
  private authToken: string | undefined;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly healthTimeoutMs: number;
  private readonly firewall: TransmissionFirewall | null;

  constructor(options: GatewayProviderOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "http://localhost:8000").replace(/\/+$/, "");
    this.authToken = options.authToken || undefined;
    this.fetchFn = options.fetchFn ?? ((...args) => globalThis.fetch(...args));
    this.timeoutMs = options.timeoutMs ?? 60000;
    this.healthTimeoutMs = options.healthTimeoutMs ?? 2000;
    this.firewall = options.firewall === null ? null : (options.firewall ?? new TransmissionFirewall());
  }

  /**
   * Adopt runtime gateway configuration (base URL / bearer token) after
   * construction — used when the UI/options page reads saved settings from
   * chrome.storage. Never throws; unknown values silently keep defaults.
   */
  configure(options: { baseUrl?: string; authToken?: string }): void {
    if (typeof options.baseUrl === "string" && options.baseUrl.trim()) {
      this.baseUrl = options.baseUrl.trim().replace(/\/+$/, "");
    }
    if (options.authToken === null || typeof options.authToken === "undefined") {
      this.authToken = undefined;
    } else if (typeof options.authToken === "string") {
      this.authToken = options.authToken.trim() || undefined;
    }
  }

  /** Classified outcome of the most recent health probe (never throws). */
  get lastHealthError(): string | null {
    return this.lastHealth.ok ? null : this.lastHealth.error;
  }

  private lastHealth: { ok: boolean; error: string | null; status?: number } = {
    ok: false,
    error: "health probe has not run yet",
  };

  /**
   * Probe the backend gateway health. Returns true only if the gateway
   * responds with HTTP 200 and { status: "ok" }.
   *
   * NOTE: this measures the LOCAL FastAPI gateway process, never Groq
   * itself. A `false` here means "the request to Groq was never sent
   * because the gateway is unreachable" — callers must surface
   * `lastHealthError` so the cause is never collapsed into a bare
   * "provider unavailable".
   */
  async available(): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.healthTimeoutMs);
    try {
      const res = await this.fetchFn(`${this.baseUrl}/health`, {
        method: "GET",
        signal: controller.signal,
      });
      if (!res.ok) {
        this.lastHealth = { ok: false, error: `health_status_${res.status}`, status: res.status };
        return false;
      }
      let data: { status?: string } | null = null;
      try {
        data = (await res.json()) as { status?: string };
      } catch {
        data = null;
      }
      const ok = data?.status === "ok";
      this.lastHealth = ok
        ? { ok: true, error: null, status: res.status }
        : { ok: false, error: "health_bad_response", status: res.status };
      return ok;
    } catch (err) {
      const errorObj = err as Error;
      const error =
        errorObj?.name === "AbortError"
          ? `health_timeout after ${this.healthTimeoutMs}ms`
          : `health_network_error: ${errorObj?.message || String(err)}`;
      this.lastHealth = { ok: false, error };
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Request the next action from the FastAPI gateway via POST /api/agent/step.
   */
  async complete(request: LlmRequest, signal?: AbortSignal): Promise<LlmResponse> {
    const stepCtx = request.stepContext;
    const payload: BackendStepPayload = {
      task: {
        goal: stepCtx?.task.goal ?? request.userPrompt?.slice(0, 120) ?? "browser task",
        intent: stepCtx?.task.intent ?? "general",
      },
      observation: {
        url: stepCtx?.observation.url ?? "",
        title: stepCtx?.observation.title ?? "",
        tabId: stepCtx?.observation.tabId ?? 0,
        pageType: stepCtx?.observation.pageType ?? "content",
        visibleText: stepCtx?.observation.visibleText ?? request.userPrompt ?? "",
        elements: (stepCtx?.observation.elements ?? []).map((el) => ({
          id: el.id,
          role: el.role,
          name: el.name,
          tag: el.tag,
        })),
      },
      history: stepCtx?.history ?? [],
      verification: stepCtx?.verification ?? null,
    };

    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), this.timeoutMs);

    // Combine abort signals if external signal provided
    const onExternalAbort = () => abortController.abort();
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        return { ok: false, error: "aborted", errorCode: "ABORTED", retryable: false };
      }
      signal.addEventListener("abort", onExternalAbort, { once: true });
    }

    // Pre-network privacy boundary: no page-derived byte leaves this
    // device without an ALLOW verdict and a rebuilt sanitized body.
    const stepUrl = `${this.baseUrl}/api/agent/step`;
    let outBody: unknown = payload;
    let outHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    let outUrl = stepUrl;
    let firewallMeta:
      | { decision: "ALLOW" | "BLOCK"; reason: string; detectedTypes: string[]; redactionCount: number }
      | undefined;
    if (this.firewall) {
      const auth = await this.firewall.authorize({
        url: stepUrl,
        method: "POST",
        headers: outHeaders,
        body: payload,
      });
      firewallMeta = {
        decision: auth.decision.decision,
        reason: auth.decision.reason,
        detectedTypes: auth.decision.detectedTypes,
        redactionCount: auth.decision.redactionCount,
      };
      if (auth.decision.decision === "BLOCK" || !auth.request) {
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onExternalAbort);
        const error = `transmission_blocked: ${auth.decision.reason} [${auth.decision.detectedTypes.join(",") || "none"}]`;
        return { ok: false, error, ...classifyGatewayError(error), firewall: firewallMeta };
      }
      outBody = auth.request.body;
      outHeaders = auth.request.headers;
      outUrl = auth.request.url;
    }

    // Gateway bearer token (extension-owned config, never page-derived):
    // re-attached AFTER firewall authorization — the firewall's header
    // allowlist drops every header but content-type/accept, and would
    // BLOCK (not sanitize) an Authorization header it saw. The token is
    // not page data, so it is out of scope for the boundary.
    if (this.authToken) {
      outHeaders["Authorization"] = `Bearer ${this.authToken}`;
    }

    let response: Response;
    try {
      response = await this.fetchFn(outUrl, {
        method: "POST",
        headers: outHeaders,
        body: JSON.stringify(outBody),
        signal: abortController.signal,
      });
    } catch (err: unknown) {
      const errorObj = err as Error;
      // An externally-aborted request is ABORTED (e.g. task stopped), never
      // a provider outage and never a timeout. Only the provider's own
      // budget timer maps to TIMEOUT.
      if (signal?.aborted) {
        return { ok: false, error: "aborted", errorCode: "ABORTED", retryable: false };
      }
      if (errorObj?.name === "AbortError" || abortController.signal.aborted) {
        return { ok: false, error: "gateway_timeout", errorCode: "TIMEOUT", retryable: true };
      }
      const error = `gateway_network_error: ${errorObj?.message || String(err)}`;
      return { ok: false, error, ...classifyGatewayError(error) };
    } finally {
      clearTimeout(timer);
      if (signal) {
        signal.removeEventListener("abort", onExternalAbort);
      }
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      const error = `gateway_malformed_json: HTTP ${response.status}`;
      return { ok: false, error, ...classifyGatewayError(error) };
    }

    if (!response.ok) {
      const detail = (data as { detail?: string })?.detail || `HTTP ${response.status}`;
      const error = `gateway_error_${response.status}: ${detail}`;
      return { ok: false, error, ...classifyGatewayError(error) };
    }

    const stepResponse = data as {
      action?: unknown;
      model?: string;
      plan?: Array<{ id?: unknown; description?: unknown }>;
      inputs?: unknown;
      generatedData?: unknown;
      interpretation?: unknown;
      usage?: unknown;
    };
    if (!stepResponse || typeof stepResponse !== "object" || !stepResponse.action) {
      const error = "gateway_missing_action: response has no action object";
      return { ok: false, error, ...classifyGatewayError(error) };
    }

    // Validate using the extension's authoritative action schema
    const validation = validateAction(stepResponse.action);
    if (!validation.ok || !validation.action) {
      const error = `gateway_invalid_action: ${validation.errors.join("; ")}`;
      return {
        ok: false,
        error,
        ...classifyGatewayError(error),
        raw: JSON.stringify(stepResponse.action),
      };
    }

    // Provider plan: optional structured task steps for the timeline.
    let plan: TaskStep[] | undefined;
    if (Array.isArray(stepResponse.plan) && stepResponse.plan.length > 0) {
      const parsed: TaskStep[] = [];
      for (const [i, item] of stepResponse.plan.entries()) {
        if (!item || typeof item !== "object") continue;
        const id = typeof item.id === "string" ? item.id : `plan_${i + 1}`;
        const text = typeof item.description === "string" ? item.description.trim() : "";
        if (text) parsed.push({ id, text, status: "pending" });
      }
      if (parsed.length > 0) plan = parsed;
    }

    // Provider task data: inputs (user-supplied) and generatedData (synthetic
    // sample values) are both flat string maps; interpretation is one line.
    const taskData: TaskData | undefined = collectTaskData(
      stepResponse.inputs,
      stepResponse.generatedData,
      stepResponse.interpretation,
    );

    return {
      ok: true,
      actions: [validation.action],
      plan,
      data: taskData,
      raw: JSON.stringify(stepResponse.action),
      ...(firewallMeta ? { firewall: firewallMeta } : {}),
    };
  }
}

/** Mirror the backend's scrubbing contract: keep only flat string values and
 * drop secret-shaped keys, so generated data shown in the UI is always
 * harmless and never looks like a real credential. */
const SECRET_KEY_PATTERN =
  /password|passwd|pwd|token|secret|apikey|api_key|credential|pin|otp|ssn|card|cvv|auth|privatekey|signature/i;

function collectDataSection(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const key = k.trim();
    if (!key || SECRET_KEY_PATTERN.test(key)) continue;
    if (typeof v === "string" && v.trim()) {
      out[key] = v.trim().slice(0, 200);
    } else if (typeof v === "number" || typeof v === "boolean") {
      out[key] = String(v).slice(0, 200);
    }
    if (Object.keys(out).length >= 24) break;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function collectTaskData(
  inputs: unknown,
  generated: unknown,
  interpretation: unknown,
): TaskData | undefined {
  const collected: TaskData = {};
  const inputsSection = collectDataSection(inputs);
  const generatedSection = collectDataSection(generated);
  if (inputsSection) collected.inputs = inputsSection;
  if (generatedSection) collected.generated = generatedSection;
  if (typeof interpretation === "string" && interpretation.trim()) {
    collected.interpretation = interpretation.trim().slice(0, 200);
  }
  return Object.keys(collected).length > 0 ? collected : undefined;
}

/**
 * Map a gateway error string onto the provider failure taxonomy. The
 * `gateway_*` prefix contract is preserved (existing consumers match on
 * it); the code/retryable pair lets the planner and the UI preserve the
 * category instead of collapsing everything into "unavailable".
 */
export function classifyGatewayError(
  error: string | undefined,
): { errorCode: GatewayErrorCode; retryable: boolean } {
  const text = error ?? "";
  if (text === "aborted" || /abort/i.test(text) && /external|caller|signal/i.test(text)) {
    return { errorCode: "ABORTED", retryable: false };
  }
  if (/gateway_timeout|timed out|timeout/i.test(text)) {
    return { errorCode: "TIMEOUT", retryable: true };
  }
  if (/not configured|missing.*key|groq_api_key/i.test(text)) {
    return { errorCode: "CONFIG", retryable: false };
  }
  if (/gateway_error_401|gateway_error_403|authentication failed|unauthorized|forbidden|invalid.*key/i.test(text)) {
    return { errorCode: "AUTH", retryable: false };
  }
  if (/gateway_error_429|rate-limit|rate limited|too many requests/i.test(text)) {
    return { errorCode: "RATE_LIMITED", retryable: true };
  }
  if (/gateway_malformed_json|gateway_missing_action|gateway_invalid_action|unusable action|unusable response|parse/i.test(text)) {
    return { errorCode: "RESPONSE_PARSE", retryable: false };
  }
  if (/gateway_error_400|gateway_error_404|gateway_error_422|bad request/i.test(text)) {
    return { errorCode: "BAD_REQUEST", retryable: false };
  }
  if (/transmission_blocked|policy_denied/i.test(text)) {
    return { errorCode: "POLICY_BLOCK", retryable: false };
  }
  if (/gateway_network_error|transport failure|fetch failed|econnrefused|enotfound|network/i.test(text)) {
    return { errorCode: "NETWORK", retryable: true };
  }
  if (/gateway_error_5\d\d|server error|bad gateway|service unavailable|gateway timeout/i.test(text)) {
    return { errorCode: "PROVIDER", retryable: true };
  }
  return { errorCode: "UNKNOWN", retryable: false };
}
