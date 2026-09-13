// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import { VisionEngine } from "@/vision/worker/vision-engine";
import { planRedactions } from "@/privacy/redaction-planner";
import { renderRedactions } from "@/privacy/redaction-render";
import { verifyRedaction } from "@/privacy/pixel-verify";
import { buildManifest } from "@/privacy/redaction-manifest";
import { RawCapture, sanitizeImage } from "@/privacy/sanitized-image";
import { authorizeVisualTransmission } from "@/privacy/transmission-permit";
import { buildVisionMetadata } from "@/privacy/vision-metadata";
import { groundVisualTarget } from "@/content/visual-grounding";
import { executeAction } from "@/content/executor";
import { buildVisualPlanner } from "@/agent/visual-planner";
import { severityFor, type SensitiveRegion } from "@/privacy/regions";
import { describe as describeStats, recordFragment } from "./helpers/metrics";
import type { VisualTransport } from "@/privacy/visual-transmission";

const WARMUP = 2;

async function time<T>(fn: () => Promise<T> | T, reps: number): Promise<{ samples: number[]; failures: number; last: T | null }> {
  for (let i = 0; i < WARMUP; i++) {
    try {
      await fn();
    } catch {
      /* warmup discarded */
    }
  }
  const samples: number[] = [];
  let failures = 0;
  let last: T | null = null;
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now();
    try {
      last = await fn();
      samples.push(performance.now() - t0);
    } catch {
      failures++;
    }
  }
  return { samples, failures, last };
}

function scene(w: number, h: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      data[i] = (x * 13 + y * 7) % 256;
      data[i + 1] = (x * 5 + y * 11) % 256;
      data[i + 2] = (x * 3 + y * 17) % 256;
      data[i + 3] = 255;
    }
  }
  return data;
}

function regions(): SensitiveRegion[] {
  return [
    {
      type: "AADHAAR",
      bbox: { x: 48, y: 92, width: 360, height: 44 },
      confidence: 0.9,
      severity: severityFor("AADHAAR", 0.9),
      source: "dom",
      sources: ["dom"],
      evidence: [],
      image: { width: 640, height: 480 },
      normalized: { x: 0, y: 0, width: 0, height: 0 },
    },
    {
      type: "PAN",
      bbox: { x: 48, y: 160, width: 200, height: 44 },
      confidence: 0.9,
      severity: severityFor("PAN", 0.9),
      source: "dom",
      sources: ["dom"],
      evidence: [],
      image: { width: 640, height: 480 },
      normalized: { x: 0, y: 0, width: 0, height: 0 },
    },
  ] as SensitiveRegion[];
}

function installDom(): { button: Element } {
  const dom = new JSDOM("<!doctype html><html><body><main><button>Submit application</button></main></body></html>", {
    url: "http://localhost/",
  });
  const g = globalThis as Record<string, unknown>;
  g.window = dom.window;
  g.document = dom.window.document;
  g.HTMLElement = dom.window.HTMLElement;
  g.HTMLInputElement = dom.window.HTMLInputElement;
  g.HTMLTextAreaElement = dom.window.HTMLTextAreaElement;
  g.HTMLButtonElement = dom.window.HTMLButtonElement;
  g.HTMLSelectElement = dom.window.HTMLSelectElement;
  g.HTMLIFrameElement = dom.window.HTMLIFrameElement;
  g.Element = dom.window.Element;
  g.Event = dom.window.Event;
  g.MouseEvent = dom.window.MouseEvent;
  g.KeyboardEvent = dom.window.KeyboardEvent;
  g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  Object.defineProperty(dom.window, "innerWidth", { value: 640, configurable: true });
  Object.defineProperty(dom.window, "innerHeight", { value: 480, configurable: true });
  Object.defineProperty(dom.window, "devicePixelRatio", { value: 1, configurable: true });
  Object.defineProperty(dom.window, "scrollX", { value: 0, configurable: true });
  Object.defineProperty(dom.window, "scrollY", { value: 0, configurable: true });
  const button = dom.window.document.querySelector("button")!;
  button.getBoundingClientRect = () =>
    ({ x: 300, y: 200, width: 100, height: 40, top: 200, left: 300, bottom: 240, right: 400, toJSON: () => ({}) }) as DOMRect;
  dom.window.document.elementFromPoint = (() => button) as unknown as typeof dom.window.document.elementFromPoint;
  return { button };
}

function uninstallDom(): void {
  const g = globalThis as Record<string, unknown>;
  for (const k of ["window", "document", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLButtonElement", "HTMLSelectElement", "HTMLIFrameElement", "Element", "Event", "MouseEvent", "KeyboardEvent", "getComputedStyle"]) {
    delete g[k];
  }
}

describe("latency benchmarks", () => {
  it("measures stages A-G with repeated runs", async () => {
    const out: Record<string, unknown> = {
      definition: {
        e2e: "time from visual-planner call start to validated action (stub capture, real inference/sanitize/permit/verify/grounding, mock VLM transport)",
        warmup: `${WARMUP} discarded iterations per stage`,
        timers: "performance.now high-resolution",
      },
      stages: {} as Record<string, unknown>,
    };
    const stages = out.stages as Record<string, unknown>;

    const engine = new VisionEngine();
    await engine.init({
      modelBase: (() => {
        const base = resolve(process.cwd(), "extension/public/models/");
        return base.endsWith("/") ? base : base + "/";
      })(),
      backend: "cpu",
    });
    const raw = readFileSync(resolve(process.cwd(), "tests/fixtures/vision/sample-cats.png"));
    const T = await import("@huggingface/transformers");
    const image = await T.RawImage.fromBlob(new Blob([new Uint8Array(raw)]));
    const iw = image.width as unknown as number;
    const ih = image.height as unknown as number;
    const idata = image.data instanceof Uint8ClampedArray ? image.data : new Uint8ClampedArray(image.data);

    const vision = await time(() => engine.infer({ id: "lat", width: iw, height: ih, data: idata, sourceWidth: iw, sourceHeight: ih }), 5);
    stages.visionInference = { ...describeStats(vision.samples), failures: vision.failures };

    const px = scene(640, 480);
    const sanitize = await time(() => {
      const capture = RawCapture.from(640, 480, px);
      const { image: img } = sanitizeImage(capture, regions());
      const manifest = img.manifest;
      const verification = img.verification;
      if (!verification.ok || manifest.regions.length !== 2) throw new Error("sanitize regression");
      img.dispose();
      capture.dispose();
    }, 15);
    stages.sanitization = { ...describeStats(sanitize.samples), failures: sanitize.failures };

    const transport: VisualTransport = {
      async post() {
        return { ok: true, status: 200, body: "{}" };
      },
    };
    const transmit = await time(async () => {
      const capture = RawCapture.from(640, 480, px);
      const { image: img } = sanitizeImage(capture, regions());
      const meta = buildVisionMetadata({ modelId: "yolos-tiny", backend: "cpu", inferenceLatencyMs: 100, detections: 0, captureWidth: 640, captureHeight: 480 });
      const { permit } = await authorizeVisualTransmission({ image: img, metadata: meta });
      if (!permit) throw new Error("no permit");
      const { transmitVisualContext } = await import("@/privacy/visual-transmission");
      const res = await transmitVisualContext({ permit, image: img, metadata: meta, task: { goal: "latency probe" }, transport, baseUrl: "http://localhost:8000", allowInsecureLocalhost: true });
      img.dispose();
      capture.dispose();
      if (res.verdict !== "ALLOW") throw new Error("transmit blocked");
    }, 15);
    stages.transmission = { ...describeStats(transmit.samples), failures: transmit.failures };

    installDom();
    const grounding = await time(() => {
      const res = groundVisualTarget({
        action: "click",
        bbox: { x: 296, y: 196, width: 108, height: 48 },
        coordinateSpace: "screenshot_pixels",
        image: { width: 640, height: 480 },
        visionConfidence: 0.94,
        label: "Submit application",
      });
      if (!res.ok) throw new Error(`grounding failed: ${res.code}`);
    }, 50);
    stages.grounding = { ...describeStats(grounding.samples), failures: grounding.failures };

    const execution = await time(async () => {
      const res = await executeAction({ action: "click", target: { role: "button", name: "Submit application" } });
      if (!res.ok) throw new Error("execute failed");
    }, 50);
    stages.execution = { ...describeStats(execution.samples), failures: execution.failures };
    uninstallDom();

    const verification = await time(() => {
      const plan = planRedactions(regions(), { width: 640, height: 480 });
      const rendered = renderRedactions({ width: 640, height: 480, data: px }, plan.operations);
      const v = verifyRedaction(
        { width: 640, height: 480, data: px },
        { width: rendered.width, height: rendered.height, data: rendered.data },
        rendered.applied,
        buildManifest(rendered.applied),
      );
      if (!v.ok) throw new Error("verify failed");
    }, 15);
    stages.verification = { ...describeStats(verification.samples), failures: verification.failures };

    const e2e = await time(async () => {
      const snap = {
        url: "https://example.com/form",
        title: "Form",
        tabId: 7,
        pageType: "content",
        viewport: { w: 640, h: 480 },
        scrollY: 0,
        scrollH: 900,
        loading: false,
        visibleText: "Submit application",
        elements: [{ id: "el_1", role: "button", name: "Submit application", tag: "button", visible: true, enabled: true, focused: false, rect: { x: 300, y: 200, w: 100, h: 40 } }],
        counted: 1,
        createdAt: Date.now(),
      };
      const planner = buildVisualPlanner(
        async () => ({ action: { action: "finish", result: "done" }, justification: "fb" }),
        {
          adapter: { sendToTabAndRespond: async () => ({ payload: { signals: [] } }) } as never,
          capture: async () => ({ raster: { width: 64, height: 48, data: new Uint8ClampedArray(px.buffer.slice(0, 64 * 48 * 4)) }, sourceWidth: 640, sourceHeight: 480, captureMs: 1 }),
          infer: async () => ({ detections: [], totalMs: 5, modelId: "yolos-tiny", backend: "cpu" }),
          transport: {
            async post() {
              return {
                ok: true,
                status: 200,
                body: JSON.stringify({
                  actions: [{ type: "click", target: { bbox: { x: 300, y: 200, width: 100, height: 40 }, normalized: { x: 0.4688, y: 0.4167, width: 0.1563, height: 0.0833 }, point: { x: 350, y: 220 } }, confidence: 0.94 }],
                  reason: "Submit",
                  completion: false,
                  status: "success",
                  model: "fake",
                  redacted_regions: 0,
                }),
              };
            },
          },
          baseUrl: "http://localhost:8000",
          allowInsecureLocalhost: true,
        },
      );
      const decision = await planner({ goal: "Click submit", intent: "general", entities: [], steps: [] }, 0, snap as never);
      if (!decision || decision.action.action !== "click") throw new Error("e2e did not ground");
    }, 10);
    stages.e2e = { ...describeStats(e2e.samples), failures: e2e.failures };

    for (const [k, v] of Object.entries(stages)) {
      const d = v as { n: number; median: number; p95: number; max: number; failures: number };
      console.log(`[metrics:latency] ${k} n=${d.n} median=${d.median.toFixed(2)}ms p95=${d.p95.toFixed(2)}ms max=${d.max.toFixed(2)}ms failures=${d.failures}`);
    }
    recordFragment("latency", out);
    await engine.dispose();

    expect(Object.values(stages).every((v) => (v as { failures: number }).failures === 0)).toBe(true);
  }, 300_000);
});
