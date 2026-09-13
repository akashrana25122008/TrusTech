// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi, afterEach } from "vitest";
import { JSDOM } from "jsdom";
import { groundVisualTarget } from "@/content/visual-grounding";
import { VisionEngine } from "@/vision/worker/vision-engine";
import { boxIou, pct, recordFragment, wilson } from "./helpers/metrics";

interface FixtureElement {
  key: string;
  role: string;
  name: string;
  tag: string;
  rect: { x: number; y: number; w: number; h: number };
  disabled?: boolean;
  child?: { tag: string; rect: { x: number; y: number; w: number; h: number } };
}

interface VisionFixture {
  id: string;
  kind: string;
  difficulty: string;
  viewport: { w: number; h: number };
  dpr?: number;
  image: { width: number; height: number };
  url?: string;
  elements: FixtureElement[];
  overlay: { x: number; y: number; w: number; h: number } | null;
  proposal: { bbox: [number, number, number, number]; space: string; label?: string; visionConfidence: number };
  expected: { role?: string; name?: string; rect?: { x: number; y: number; w: number; h: number }; code?: string };
}

const TAG_FOR_ROLE: Record<string, string> = {
  button: "button",
  link: "a",
  textbox: "input",
  searchbox: "input",
  combobox: "select",
};

function mount(fx: VisionFixture): void {
  const dom = new JSDOM("<!doctype html><html><body><main></main></body></html>", { url: "http://localhost/" });
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
  g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  const doc = dom.window.document;
  Object.defineProperty(dom.window, "innerWidth", { value: fx.viewport.w, configurable: true });
  Object.defineProperty(dom.window, "innerHeight", { value: fx.viewport.h, configurable: true });
  Object.defineProperty(dom.window, "devicePixelRatio", { value: fx.dpr ?? 1, configurable: true });
  Object.defineProperty(dom.window, "scrollX", { value: 0, configurable: true });
  Object.defineProperty(dom.window, "scrollY", { value: 0, configurable: true });

  const main = doc.querySelector("main")!;
  const placed: Array<{ el: Element; rect: { x: number; y: number; w: number; h: number } }> = [];
  const put = (el: Element, rect: { x: number; y: number; w: number; h: number }) => {
    el.getBoundingClientRect = () =>
      ({ x: rect.x, y: rect.y, width: rect.w, height: rect.h, top: rect.y, left: rect.x, bottom: rect.y + rect.h, right: rect.x + rect.w, toJSON: () => ({}) }) as DOMRect;
    placed.push({ el, rect });
  };
  for (const e of fx.elements) {
    const tag = TAG_FOR_ROLE[e.role] ?? e.tag;
    const el = doc.createElement(tag);
    el.setAttribute("data-key", e.key);
    if (tag === "a") el.setAttribute("href", "#");
    if (e.name && !e.child) {
      if (tag === "input" || tag === "select") el.setAttribute("aria-label", e.name);
      else el.textContent = e.name;
    }
    if (e.disabled) (el as HTMLButtonElement).disabled = true;
    main.appendChild(el);
    put(el, e.rect);
    if (e.child) {
      const child = doc.createElement(e.child.tag);
      child.textContent = e.name;
      el.appendChild(child);
      put(child, e.child.rect);
    }
  }
  let overlayEl: Element | null = null;
  if (fx.overlay) {
    overlayEl = doc.createElement("div");
    overlayEl.textContent = "modal";
    main.appendChild(overlayEl);
    put(overlayEl, fx.overlay);
  }
  doc.elementFromPoint = ((x: number, y: number): Element | null => {
    if (overlayEl) {
      const r = fx.overlay!;
      if (x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h) return overlayEl;
    }
    const hits = placed.filter(({ rect }) => x >= rect.x && y >= rect.y && x < rect.x + rect.w && y < rect.y + rect.h);
    if (hits.length === 0) return null;
    hits.sort((a, b) => a.rect.w * a.rect.h - b.rect.w * b.rect.h);
    const childHit = hits.find((h) => (h.el.parentElement as Element | null)?.tagName === "BUTTON");
    return (childHit ?? hits[0]).el;
  }) as unknown as typeof doc.elementFromPoint;
}

afterEach(() => {
  vi.restoreAllMocks();
  const g = globalThis as Record<string, unknown>;
  for (const k of ["window", "document", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLButtonElement", "HTMLSelectElement", "HTMLIFrameElement", "Element", "getComputedStyle"]) {
    delete g[k];
  }
});

function loadFixtures(): VisionFixture[] {
  const doc = JSON.parse(readFileSync(resolve(process.cwd(), "tests/metrics/fixtures/vision.json"), "utf-8"));
  return doc.fixtures as VisionFixture[];
}

describe("vision grounding accuracy", () => {
  it("resolves proposals to the intended element or the documented failure", () => {
    const fixtures = loadFixtures();
    const rows: Array<{
      id: string;
      kind: string;
      difficulty: string;
      pass: boolean;
      expected: unknown;
      actual: unknown;
      iou: number | null;
    }> = [];

    for (const fx of fixtures) {
      mount(fx);
      const res = groundVisualTarget({
        action: "click",
        bbox: { x: fx.proposal.bbox[0], y: fx.proposal.bbox[1], width: fx.proposal.bbox[2], height: fx.proposal.bbox[3] },
        coordinateSpace: fx.proposal.space as "screenshot_pixels",
        image: fx.image,
        url: fx.url,
        visionConfidence: fx.proposal.visionConfidence,
        label: fx.proposal.label,
      });
      const mapped = res.mappedBbox
        ? { x: res.mappedBbox.x, y: res.mappedBbox.y, width: res.mappedBbox.width, height: res.mappedBbox.height }
        : null;
      const proposalBox = { x: fx.proposal.bbox[0], y: fx.proposal.bbox[1], width: fx.proposal.bbox[2], height: fx.proposal.bbox[3] };
      let pass = false;
      let actual: unknown;
      if (fx.expected.code) {
        pass = !res.ok && res.code === fx.expected.code;
        actual = res.ok ? { ok: true } : { code: res.code };
      } else if (fx.expected.rect) {
        const vp = res.viewportPoint;
        const exp = fx.expected.rect;
        pass = res.ok && vp !== undefined && vp.x >= exp.x && vp.y >= exp.y && vp.x < exp.x + exp.w && vp.y < exp.y + exp.h && res.elementRole === "button";
        actual = { ok: res.ok, viewportPoint: vp, role: res.elementRole, name: res.elementName };
      } else {
        pass = res.ok && res.elementRole === fx.expected.role && res.elementName === fx.expected.name;
        actual = { ok: res.ok, role: res.elementRole, name: res.elementName, code: res.code };
      }
      rows.push({
        id: fx.id,
        kind: fx.kind,
        difficulty: fx.difficulty,
        pass,
        expected: fx.expected,
        actual,
        iou: mapped ? boxIou(mapped, proposalBox) : null,
      });
    }

    const passed = rows.filter((r) => r.pass).length;
    const accuracy = passed / rows.length;
    const [lo, hi] = wilson(accuracy, rows.length);
    const meanIou = rows.filter((r) => r.iou !== null).reduce((a, r) => a + (r.iou ?? 0), 0) / rows.length;

    recordFragment("vision", {
      definition: "grounding accuracy = proposals resolved to the intended element (or documented failure code) / all proposals",
      iouNote: "mean proposal-vs-mapped IoU is reported for information only (mapping is exact by construction when dims match)",
      fixtures: rows.length,
      passed,
      accuracy,
      accuracyPct: pct(accuracy),
      wilson95: [lo, hi],
      meanProposalIou: meanIou,
      rows,
    });

    for (const r of rows) {
      console.log(`[metrics:vision] ${r.id} ${r.pass ? "PASS" : "FAIL"} (${r.kind}) expected=${JSON.stringify(r.expected)} actual=${JSON.stringify(r.actual)}`);
    }
    console.log(`[metrics:vision] accuracy=${pct(accuracy)}% (${passed}/${rows.length}) wilson95=[${pct(lo)}%,${pct(hi)}%]`);
    expect(rows.filter((r) => !r.pass)).toEqual([]);
  });

  it("real-model detection line on sample-cats.png (informational, not headline)", async () => {
    const engine = new VisionEngine();
    await engine.init({
      modelBase: (() => {
        const base = resolve(process.cwd(), "extension/public/models/");
        return base.endsWith("/") ? base : base + "/";
      })(),
      backend: "cpu",
    });
    const { readFileSync: read } = await import("node:fs");
    const raw = read(resolve(process.cwd(), "tests/fixtures/vision/sample-cats.png"));
    const T = await import("@huggingface/transformers");
    const image = await T.RawImage.fromBlob(new Blob([new Uint8Array(raw)]));
    const width = image.width as unknown as number;
    const height = image.height as unknown as number;
    const data = image.data instanceof Uint8ClampedArray ? image.data : new Uint8ClampedArray(image.data);
    const t0 = performance.now();
    const result = await engine.infer({ id: "metrics-cats", width, height, data, sourceWidth: width, sourceHeight: height });
    const inferMs = performance.now() - t0;
    const cats = result.detections.filter((d) => d.label === "cat");
    recordFragment("vision-model", {
      note: "Known-target presence on a real photo (2 cats in frame per AT-01). No GT boxes exist, so this line is informational and excluded from headline accuracy.",
      image: "sample-cats.png",
      detections: result.detections.map((d) => ({ label: d.label, type: d.type, confidence: d.confidence, bbox: d.bbox })),
      catDetections: cats.length,
      knownTargetsPresent: 2,
      catRecall: cats.length >= 2 ? 1 : cats.length / 2,
      inferenceMs: Math.round(inferMs * 100) / 100,
    });
    console.log(`[metrics:vision-model] detections=${result.detections.length} cats=${cats.length}/2 inferMs=${inferMs.toFixed(0)}`);
    await engine.dispose();
    expect(cats.length).toBeGreaterThanOrEqual(1);
  }, 120_000);
});
