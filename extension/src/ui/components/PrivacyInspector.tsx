import { useCallback, useEffect, useRef, useState } from "react";
import { Eye, Loader2, ScanLine, ShieldAlert, Cpu, ShieldCheck, ShieldX } from "lucide-react";
import { captureActiveTab } from "@/vision/capture";
import { MODEL_QUANTIZED_BYTES } from "@/vision/model";
import { VisionWorkerClient } from "@/vision/vision-worker-client";
import { requestDomPrivacyScan } from "@/privacy/panel-client";
import { analyzePrivacy, type PrivacyAnalysis } from "@/privacy/privacy-analyzer";
import { decidePrivacy, type PrivacyDecision } from "@/privacy/decision";
import { RawCapture, sanitizeImage, type SanitizedImage } from "@/privacy/sanitized-image";
import type { VisionBackend } from "@/vision/types";

/* ------------------------------------------------------------------ *
 * PrivacyInspector — Phase 2 visual + DOM privacy intelligence panel.
 *
 * One analysis = capture → Phase 1 vision detector (real worker) + live
 * DOM scan (content script) → existing PII text engine → fusion engine →
 * final SensitiveRegion[] → privacy decision. Every overlay box and
 * severity label is derived from a fused SensitiveRegion; nothing here
 * fabricates detections. OCR (when a provider ships) plugs in behind
 * analyzePrivacy with zero UI changes.
 * ------------------------------------------------------------------ */

type Phase = "idle" | "loading" | "ready" | "analyzing" | "error";

interface Snapshot {
  dataUrl: string;
  sourceWidth: number;
  sourceHeight: number;
}

export function PrivacyInspector() {
  const clientRef = useRef<VisionWorkerClient | null>(null);
  // Private pixel copy retained for the redaction pipeline (the worker
  // neuters the original buffer via zero-copy transfer). Disposed after
  // sanitizing — the raw capture never outlives the analysis view.
  const redactRef = useRef<{ pixels: Uint8ClampedArray; width: number; height: number } | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [backend, setBackend] = useState<VisionBackend | "pending">("pending");
  const [loadMs, setLoadMs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<PrivacyAnalysis | null>(null);
  const [decision, setDecision] = useState<PrivacyDecision | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [domSignalCount, setDomSignalCount] = useState<number | null>(null);
  const [sanitized, setSanitized] = useState<SanitizedImage | null>(null);
  const [sanitizeError, setSanitizeError] = useState<string | null>(null);
  const [sanitizing, setSanitizing] = useState(false);

  const init = useCallback(async () => {
    if (clientRef.current) return clientRef.current;
    setPhase("loading");
    const client = new VisionWorkerClient({ backend: "auto" });
    clientRef.current = client;
    try {
      const info = await client.init();
      setBackend(info.backend);
      setLoadMs(info.loadMs);
      setPhase("ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
    return client;
  }, []);

  useEffect(() => {
    void init();
    return () => {
      void clientRef.current?.dispose();
      clientRef.current = null;
      setSanitized((prev) => {
        prev?.dispose();
        return null;
      });
    };
  }, [init]);

  const analyze = useCallback(async () => {
    const client = clientRef.current ?? (await init());
    if (!client || phase !== "ready") return;
    setPhase("analyzing");
    setError(null);
    setAnalysis(null);
    setDecision(null);
    setSnapshot(null);
    setSanitizeError(null);
    setSanitized((prev) => {
      prev?.dispose();
      return null;
    });
    try {
      const captured = await captureActiveTab(720);
      // The worker takes ownership of the raster buffer (zero-copy
      // transfer neuters our copy), so retain a private copy for the
      // redaction pipeline BEFORE inference.
      const redactPixels = new Uint8ClampedArray(captured.raster.data);
      const [vision, domScan] = await Promise.all([
        client.infer({
          width: captured.raster.width,
          height: captured.raster.height,
          data: captured.raster.data,
          sourceWidth: captured.sourceWidth,
          sourceHeight: captured.sourceHeight,
        }),
        requestDomPrivacyScan(),
      ]);
      const result = await analyzePrivacy({
        image: { width: vision.sourceWidth, height: vision.sourceHeight },
        viewport: domScan?.viewport ?? { width: vision.sourceWidth, height: vision.sourceHeight },
        dom: domScan ?? null,
        visionDetections: vision.detections,
        visionMs: vision.metrics.totalMs,
        captureMs: captured.captureMs,
      });
      const d = decidePrivacy(result.regions);
      setAnalysis(result);
      setDecision(d);
      setDomSignalCount(domScan?.signals.length ?? null);
      setSnapshot({ dataUrl: captured.dataUrl, sourceWidth: vision.sourceWidth, sourceHeight: vision.sourceHeight });
      redactRef.current = {
        pixels: redactPixels,
        width: captured.raster.width,
        height: captured.raster.height,
      };
      setPhase("ready");
    } catch (err) {
      redactRef.current = null;
      setError(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  }, [init, phase]);

  const sanitize = useCallback(() => {
    const pending = redactRef.current;
    if (!pending || !analysis || sanitizing) return;
    setSanitizing(true);
    setSanitizeError(null);
    try {
      // Regions are canonical image-relative; the retained raster may be
      // downscaled vs the full capture, so scale boxes into raster pixels.
      const sx = pending.width / snapshot!.sourceWidth;
      const sy = pending.height / snapshot!.sourceHeight;
      const scaled = analysis.regions.map((r) => ({
        ...r,
        bbox: {
          x: r.bbox.x * sx,
          y: r.bbox.y * sy,
          width: r.bbox.width * sx,
          height: r.bbox.height * sy,
        },
        image: { width: pending.width, height: pending.height },
      }));
      const raw = RawCapture.from(pending.width, pending.height, pending.pixels);
      const { image } = sanitizeImage(raw, scaled);
      raw.dispose();
      pending.pixels.fill(0);
      redactRef.current = null;
      setSanitized((prev) => {
        prev?.dispose();
        return image;
      });
    } catch (err) {
      setSanitizeError(err instanceof Error ? err.message : String(err));
    } finally {
      setSanitizing(false);
    }
  }, [analysis, snapshot, sanitizing]);

  return (
    <section className="privacy" data-phase={phase}>
      <div className="privacy__header">
        <span className="privacy__title-row">
          <Eye size={14} aria-hidden="true" />
          <span>Privacy intelligence</span>
        </span>
        <span className="privacy__backend" data-backend={backend}>
          <Cpu size={11} aria-hidden="true" />
          {backend === "pending" ? "detecting…" : `${backend} + DOM`}
        </span>
      </div>

      {loadMs != null && (
        <div className="privacy__loadnote">
          Local model loaded in {loadMs.toFixed(0)} ms (~{(MODEL_QUANTIZED_BYTES / 1e6).toFixed(1)} MB quantized)
        </div>
      )}

      <div className="privacy__actions">
        <button
          type="button"
          className="btn-control"
          onClick={analyze}
          disabled={phase === "loading" || phase === "analyzing"}
          aria-label="Capture the visible page and run the fused visual + DOM privacy analysis"
        >
          {phase === "analyzing" ? <Loader2 className="spin" size={14} aria-hidden="true" /> : <ScanLine size={14} aria-hidden="true" />}
          {phase === "analyzing" ? "Analyzing…" : "Scan page for sensitive regions"}
        </button>
        {phase === "ready" && <span className="privacy__hint">100% local — nothing leaves this browser</span>}
        {analysis && analysis.regions.length > 0 && !sanitized && (
          <button
            type="button"
            className="btn-control"
            onClick={sanitize}
            disabled={sanitizing}
            aria-label="Redact the sensitive regions from the captured pixels and verify the result"
          >
            {sanitizing ? <Loader2 className="spin" size={14} aria-hidden="true" /> : <ShieldCheck size={14} aria-hidden="true" />}
            {sanitizing ? "Sanitizing…" : "Sanitize pixels"}
          </button>
        )}
      </div>

      {sanitizeError && (
        <div className="privacy__error" role="alert">
          <ShieldAlert size={13} aria-hidden="true" />
          Sanitization blocked: {sanitizeError}
        </div>
      )}

      {sanitized && (
        <div className="privacy__sanitized" data-verified={sanitized.verification.ok}>
          <div className="block-eyebrow">SANITIZED IMAGE · VERIFIED</div>
          <div className="privacy__metric-row">
            <span>Manifest</span><span>v{sanitized.manifest.version} · {sanitized.manifest.regions.length} regions</span>
            <span>Methods</span><span>{[...new Set(sanitized.manifest.regions.map((r) => r.method))].join(" + ") || "—"}</span>
            <span>Redacted</span><span>{sanitized.verification.redactedPixels.toLocaleString()} px</span>
            <span>Preserved</span><span>{sanitized.verification.preservedPixels.toLocaleString()} px</span>
            <span>Sanitize</span><span>{sanitized.sanitizeMs.toFixed(1)} ms</span>
          </div>
          <ul className="privacy__list">
            {sanitized.manifest.regions.map((r) => (
              <li key={r.id} data-severity="medium">
                <span className="privacy__type">{r.id}</span>
                <span className="privacy__sev">{r.method}</span>
                <span className="privacy__conf">{r.type}</span>
                <span className="privacy__src">[{r.bbox.join(", ")}]</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {phase === "error" && error && (
        <div className="privacy__error" role="alert">
          <ShieldAlert size={13} aria-hidden="true" />
          {error}
        </div>
      )}

      {phase === "ready" && decision && (
        <div className="privacy__decision" data-verdict={decision.verdict}>
          {decision.verdict === "SAFE" ? (
            <ShieldCheck size={14} aria-hidden="true" />
          ) : (
            <ShieldX size={14} aria-hidden="true" />
          )}
          <span>
            <strong>{decision.verdict}</strong> · {decision.evidenceBrief || "No sensitive regions"}
          </span>
          {decision.action === "block" && <em className="privacy__decision-action">block outgoing</em>}
          {decision.action === "sanitize" && <em className="privacy__decision-action">sanitize text</em>}
        </div>
      )}

      {analysis && snapshot && (
        <div className="privacy__results">
          <div className="privacy__preview-wrap">
            <img className="privacy__preview" src={snapshot.dataUrl} alt="Captured page frame with sensitive region overlay" />
            <div className="privacy__overlay">
              {analysis.regions.map((r, i) => (
                <div
                  key={`${r.type}-${i}`}
                  className="privacy__region"
                  data-severity={r.severity}
                  style={{
                    left: `${(r.bbox.x / snapshot.sourceWidth) * 100}%`,
                    top: `${(r.bbox.y / snapshot.sourceHeight) * 100}%`,
                    width: `${(r.bbox.width / snapshot.sourceWidth) * 100}%`,
                    height: `${(r.bbox.height / snapshot.sourceHeight) * 100}%`,
                  }}
                >
                  <span className="privacy__region-label">
                    {r.type} · {(r.confidence * 100).toFixed(0)}% · {r.sources.join("+")}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="privacy__summary">
            <div className="block-eyebrow">FUSED SENSITIVE REGIONS</div>
            {analysis.regions.length === 0 ? (
              <div className="privacy__empty">No sensitive regions found on this page.</div>
            ) : (
              <ul className="privacy__list">
                {analysis.regions.map((r, i) => (
                  <li key={`${r.type}-${i}`} data-severity={r.severity}>
                    <span className="privacy__type">{r.type}</span>
                    <span className="privacy__sev">{r.severity}</span>
                    <span className="privacy__conf">{(r.confidence * 100).toFixed(0)}%</span>
                    <span className="privacy__src">{r.sources.join("+")}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="privacy__metrics">
            <div className="block-eyebrow">ANALYSIS LATENCY</div>
            <div className="privacy__metric-row">
              <span>Capture</span><span>{analysis.metrics.captureMs.toFixed(1)} ms</span>
              <span>DOM scan</span><span>{analysis.metrics.domScanMs.toFixed(1)} ms{domSignalCount != null ? ` (${domSignalCount} signals)` : ""}</span>
              <span>Vision</span><span>{analysis.metrics.visionMs.toFixed(1)} ms</span>
              <span>OCR</span><span>{analysis.metrics.ocrMs.toFixed(1)} ms</span>
              <span>Fusion</span><span>{analysis.metrics.fusionMs.toFixed(1)} ms</span>
              <span>Total</span><span className="privacy__metric-total">{analysis.metrics.totalMs.toFixed(1)} ms</span>
              <span>Candidates</span><span>{analysis.metrics.candidateCount}</span>
              <span>Fused</span><span>{analysis.metrics.regionCount}</span>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}