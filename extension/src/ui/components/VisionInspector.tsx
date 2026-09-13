import { useCallback, useEffect, useRef, useState } from "react";
import { Eye, Loader2, ScanLine, ShieldAlert, Cpu } from "lucide-react";
import { captureActiveTab } from "@/vision/capture";
import { MODEL_QUANTIZED_BYTES } from "@/vision/model";
import { VisionWorkerClient, type VisionWorkerClientOptions } from "@/vision/vision-worker-client";
import type { VisionBackend, VisionDetection, VisionInferResult } from "@/vision/types";

/* ------------------------------------------------------------------ *
 * VisionInspector — on-device live-frame analysis panel section.
 *
 * Captures the active tab, transfers the raster (zero-copy ArrayBuffer)
 * to a dedicated vision worker, runs the bundled quantized YOLOS-tiny
 * CNN/ViT detector fully locally, and renders real detections with
 * measured latency stages. Nothing here simulates the model output —
 * boxes and metrics only ever come from the worker's INFER_RESULT.
 * ------------------------------------------------------------------ */

type Phase = "idle" | "loading" | "ready" | "analyzing" | "error";

interface Snapshot {
  dataUrl: string;
  sourceWidth: number;
  sourceHeight: number;
}

export function VisionInspector({ options }: { options?: VisionWorkerClientOptions }) {
  const clientRef = useRef<VisionWorkerClient | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [backend, setBackend] = useState<VisionBackend | "pending">("pending");
  const [loadMs, setLoadMs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<VisionInferResult | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);

  const init = useCallback(async () => {
    if (clientRef.current) return clientRef.current;
    setPhase("loading");
    const client = new VisionWorkerClient(options);
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
  }, [options]);

  useEffect(() => {
    void init();
    return () => {
      void clientRef.current?.dispose();
      clientRef.current = null;
    };
  }, [init]);

  const analyze = useCallback(async () => {
    const client = clientRef.current ?? (await init());
    if (!client || phase !== "ready") return;
    setPhase("analyzing");
    setError(null);
    setResult(null);
    setSnapshot(null);
    try {
      const captured = await captureActiveTab(720);
      const res = await client.infer({
        width: captured.raster.width,
        height: captured.raster.height,
        data: captured.raster.data,
        sourceWidth: captured.sourceWidth,
        sourceHeight: captured.sourceHeight,
      });
      res.metrics.captureMs = captured.captureMs;
      res.metrics.totalMs += captured.captureMs;
      setResult(res);
      setSnapshot({ dataUrl: captured.dataUrl, sourceWidth: res.sourceWidth, sourceHeight: res.sourceHeight });
      setPhase("ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  }, [init, phase]);

  return (
    <section className="vision" data-phase={phase}>
      <div className="vision__header">
        <span className="vision__title-row">
          <Eye size={14} aria-hidden="true" />
          <span>On-device vision</span>
        </span>
        <span className="vision__backend" data-backend={backend}>
          <Cpu size={11} aria-hidden="true" />
          {backend === "pending" ? "detecting…" : backend}
        </span>
      </div>

      {loadMs != null && (
        <div className="vision__loadnote">Model loaded locally in {loadMs.toFixed(0)} ms (~{(MODEL_QUANTIZED_BYTES / 1e6).toFixed(1)} MB quantized)</div>
      )}

      <div className="vision__actions">
        <button
          type="button"
          className="btn-control"
          onClick={analyze}
          disabled={phase === "loading" || phase === "analyzing"}
          aria-label="Capture the visible page and run local object detection"
        >
          {phase === "analyzing" ? <Loader2 className="spin" size={14} aria-hidden="true" /> : <ScanLine size={14} aria-hidden="true" />}
          {phase === "analyzing" ? "Analyzing…" : "Analyze visible page"}
        </button>
        {phase === "ready" && <span className="vision__hint">runs 100% locally in this browser</span>}
      </div>

      {phase === "error" && error && (
        <div className="vision__error" role="alert">
          <ShieldAlert size={13} aria-hidden="true" />
          {error}
        </div>
      )}

      {result && (
        <div className="vision__results">
          <div className="vision__preview-wrap">
            {snapshot && <img className="vision__preview" src={snapshot.dataUrl} alt="Captured page frame" />}
            {snapshot && (
              <div className="vision__overlay">
                {result.detections.map((d: VisionDetection, i: number) => (
                  <div
                    key={`${d.label}-${i}`}
                    className="vision__detect"
                    data-type={d.type}
                    style={{
                      left: `${(d.bbox.x / result.sourceWidth) * 100}%`,
                      top: `${(d.bbox.y / result.sourceHeight) * 100}%`,
                      width: `${(d.bbox.width / result.sourceWidth) * 100}%`,
                      height: `${(d.bbox.height / result.sourceHeight) * 100}%`,
                    }}
                  >
                    <span className="vision__detect-label">
                      {d.label} · {d.confidence.toFixed(2)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="vision__metrics">
            <div className="block-eyebrow">INFERENCE LATENCY</div>
            <div className="vision__metric-row">
              <span>Capture</span><span>{result.metrics.captureMs.toFixed(1)} ms</span>
              <span>Preprocess</span><span>{result.metrics.preprocessMs.toFixed(1)} ms</span>
              <span>Inference</span><span>{result.metrics.inferenceMs.toFixed(1)} ms</span>
              <span>Postprocess</span><span>{result.metrics.postprocessMs.toFixed(1)} ms</span>
              <span>Total</span><span className="vision__metric-total">{result.metrics.totalMs.toFixed(1)} ms</span>
              <span>Detections</span><span>{result.detections.length}</span>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}