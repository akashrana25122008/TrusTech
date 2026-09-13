import { describe, it, expect, vi, afterEach } from "vitest";
import { groundVisualTarget, mapToViewportCss, normalizeVisualBbox, type VisualGroundingRequest } from "@/content/visual-grounding";
import { groundVisionPoint } from "@/content/vision-bridge";

function viewport(w: number, h: number, dpr = 1, scrollX = 0, scrollY = 0) {
  Object.defineProperty(window, "innerWidth", { value: w, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: h, configurable: true });
  Object.defineProperty(window, "devicePixelRatio", { value: dpr, configurable: true });
  Object.defineProperty(window, "scrollX", { value: scrollX, configurable: true });
  Object.defineProperty(window, "scrollY", { value: scrollY, configurable: true });
}

function rectOf(el: Element, x: number, y: number, w: number, h: number) {
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
    x, y, width: w, height: h, top: y, left: x, bottom: y + h, right: x + w, toJSON: () => {},
  } as DOMRect);
}

function hit(el: Element | null) {
  Object.defineProperty(document, "elementFromPoint", { value: vi.fn().mockReturnValue(el), configurable: true, writable: true });
}

function req(partial: Partial<VisualGroundingRequest> = {}): VisualGroundingRequest {
  return {
    action: "click",
    bbox: { x: 300, y: 200, width: 100, height: 40 },
    coordinateSpace: "screenshot_pixels",
    image: { width: 640, height: 480 },
    visionConfidence: 0.94,
    ...partial,
  };
}

function buttonScene(label = "Submit application", disabled = false) {
  document.body.innerHTML = `<main><button id="t">${label}</button></main>`;
  const button = document.getElementById("t")!;
  if (disabled) (button as HTMLButtonElement).disabled = true;
  rectOf(button, 300, 200, 100, 40);
  return button;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("normalizeVisualBbox", () => {
  it("accepts object and tuple forms, rejects malformed boxes", () => {
    expect(normalizeVisualBbox({ x: 1, y: 2, width: 3, height: 4 }, undefined, { width: 10, height: 10 })).toEqual({ x: 1, y: 2, width: 3, height: 4 });
    expect(normalizeVisualBbox([1, 2, 3, 4], undefined, { width: 10, height: 10 })).toEqual({ x: 1, y: 2, width: 3, height: 4 });
    expect(normalizeVisualBbox(undefined, { x: 0.5, y: 0.5, width: 0.25, height: 0.25 }, { width: 640, height: 480 })).toEqual({ x: 320, y: 240, width: 160, height: 120 });
    expect(normalizeVisualBbox({ x: 1, y: 1, width: 0, height: 4 }, undefined, { width: 10, height: 10 })).toBeNull();
    expect(normalizeVisualBbox({ x: NaN, y: 1, width: 3, height: 4 }, undefined, { width: 10, height: 10 })).toBeNull();
    expect(normalizeVisualBbox([1, 2, 3] as unknown as [number, number, number, number], undefined, { width: 10, height: 10 })).toBeNull();
    expect(normalizeVisualBbox(undefined, { x: 1.5, y: 0, width: 0.1, height: 0.1 }, { width: 10, height: 10 })).toBeNull();
    expect(normalizeVisualBbox(undefined, undefined, { width: 10, height: 10 })).toBeNull();
  });
});

describe("mapToViewportCss", () => {
  const live = { width: 640, height: 480, dpr: 2, scrollX: 0, scrollY: 600 };
  it("scales screenshot pixels by viewport/image ratio", () => {
    expect(mapToViewportCss({ x: 600, y: 400, width: 200, height: 80 }, "screenshot_pixels", { width: 1280, height: 960 }, live)).toEqual({ x: 300, y: 200, width: 100, height: 40 });
  });
  it("divides device pixels by live DPR", () => {
    expect(mapToViewportCss({ x: 600, y: 400, width: 200, height: 80 }, "device_pixels", { width: 1280, height: 960 }, live)).toEqual({ x: 300, y: 200, width: 100, height: 40 });
  });
  it("passes viewport CSS through and subtracts live scroll for page CSS", () => {
    expect(mapToViewportCss({ x: 1, y: 2, width: 3, height: 4 }, "viewport_css", { width: 9, height: 9 }, live)).toEqual({ x: 1, y: 2, width: 3, height: 4 });
    expect(mapToViewportCss({ x: 100, y: 800, width: 50, height: 20 }, "page_css", { width: 640, height: 2000 }, live)).toEqual({ x: 100, y: 200, width: 50, height: 20 });
  });
  it("applies crop origin before scaling", () => {
    expect(mapToViewportCss({ x: 0, y: 0, width: 100, height: 40 }, "screenshot_pixels", { width: 640, height: 480 }, { ...live, dpr: 1 }, { x: 300, y: 200 })).toEqual({ x: 300, y: 200, width: 100, height: 40 });
  });
  it("rejects unknown spaces", () => {
    expect(mapToViewportCss({ x: 1, y: 1, width: 2, height: 2 }, "screen_css" as never, { width: 9, height: 9 }, live)).toBeNull();
  });
});

describe("groundVisualTarget mapping (CASE 1-6)", () => {
  it("CASE 1 — identical screenshot and viewport dimensions map 1:1", () => {
    viewport(640, 480);
    const button = buttonScene();
    hit(button);
    const res = groundVisualTarget(req());
    expect(res.ok).toBe(true);
    expect(res.viewportPoint).toEqual({ x: 350, y: 220 });
    expect(res.mappedBbox).toEqual({ x: 300, y: 200, width: 100, height: 40 });
    expect(res.action?.action).toBe("click");
  });

  it("CASE 2 — DPR 2 screenshot pixels convert to CSS pixels", () => {
    viewport(640, 480, 2);
    const button = buttonScene();
    hit(button);
    const res = groundVisualTarget(req({ bbox: { x: 600, y: 400, width: 200, height: 80 }, image: { width: 1280, height: 960 } }));
    expect(res.ok).toBe(true);
    expect(res.viewportPoint).toEqual({ x: 350, y: 220 });
    expect(res.evidence.dpr).toBe(2);
  });

  it("CASE 3 — viewport resize is rejected, never remapped blindly", () => {
    viewport(800, 600);
    const button = buttonScene();
    hit(button);
    const res = groundVisualTarget(req({ viewport: { width: 640, height: 480 } }));
    expect(res.ok).toBe(false);
    expect(res.code).toBe("VIEWPORT_CHANGED");
  });

  it("CASE 4 — page CSS accounts for live scroll", () => {
    viewport(640, 480, 1, 0, 600);
    const button = buttonScene();
    hit(button);
    const res = groundVisualTarget(
      req({ coordinateSpace: "page_css", bbox: { x: 300, y: 800, width: 100, height: 40 }, scroll: { x: 0, y: 600 } }),
    );
    expect(res.ok).toBe(true);
    expect(res.viewportPoint).toEqual({ x: 350, y: 220 });
    expect(res.evidence.scrollDelta).toEqual({ x: 0, y: 0 });
  });

  it("CASE 5 — partially-outside targets are rejected, not blind-clicked", () => {
    viewport(640, 480);
    const button = buttonScene();
    hit(button);
    const res = groundVisualTarget(req({ bbox: { x: 500, y: 400, width: 200, height: 200 } }));
    expect(res.ok).toBe(false);
    expect(res.code).toBe("COORDINATE_OUT_OF_BOUNDS");
  });

  it("CASE 6 — invalid bboxes rejected", () => {
    viewport(640, 480);
    for (const bbox of [
      { x: 1, y: 1, width: 0, height: 5 },
      { x: NaN, y: 1, width: 5, height: 5 },
      { x: 1, y: 1, width: -4, height: 5 },
    ]) {
      expect(groundVisualTarget(req({ bbox })).code).toBe("BBOX_INVALID");
    }
  });
});

describe("groundVisualTarget DOM grounding (CASE 7-12)", () => {
  it("CASE 7 — bbox maps to the intended button with identity evidence", () => {
    viewport(640, 480);
    const button = buttonScene();
    hit(button);
    const res = groundVisualTarget(req({ label: "Submit" }));
    expect(res.ok).toBe(true);
    expect(res.elementRole).toBe("button");
    expect(res.elementName).toContain("Submit");
    expect(res.elementId).toMatch(/^el_/);
    expect(res.targetConfidence).toBeGreaterThanOrEqual(0.6);
  });

  it("CASE 8 — wrong element for the stated label is rejected", () => {
    viewport(640, 480);
    const button = buttonScene();
    hit(button);
    const res = groundVisualTarget(req({ label: "Cancel subscription" }));
    expect(res.ok).toBe(false);
    expect(res.code).toBe("DOM_TARGET_MISMATCH");
  });

  it("CASE 9 — child span resolves to the clickable button ancestor", () => {
    viewport(640, 480);
    document.body.innerHTML = `<main><button id="t"><span id="s">Submit</span></button></main>`;
    const button = document.getElementById("t")!;
    const span = document.getElementById("s")!;
    rectOf(button, 300, 200, 100, 40);
    rectOf(span, 310, 210, 40, 20);
    hit(span);
    const res = groundVisualTarget(req());
    expect(res.ok).toBe(true);
    expect(res.elementRole).toBe("button");
  });

  it("CASE 10 — disabled targets are blocked", () => {
    viewport(640, 480);
    const button = buttonScene("Submit application", true);
    hit(button);
    const res = groundVisualTarget(req());
    expect(res.ok).toBe(false);
    expect(res.code).toBe("TARGET_DISABLED");
  });

  it("CASE 11 — occluding overlay blocks instead of blind click", () => {
    viewport(640, 480);
    document.body.innerHTML = `<main><button id="t">Submit</button><div id="o">modal</div></main>`;
    const button = document.getElementById("t")!;
    const overlay = document.getElementById("o")!;
    rectOf(button, 300, 200, 100, 40);
    rectOf(overlay, 290, 190, 120, 60);
    hit(overlay);
    const res = groundVisualTarget(req());
    expect(res.ok).toBe(false);
    expect(res.code).toBe("TARGET_OCCLUDED");
  });

  it("CASE 12 — vanished target is detected", () => {
    viewport(640, 480);
    buttonScene();
    hit(null);
    const res = groundVisualTarget(req());
    expect(res.ok).toBe(false);
    expect(res.code).toBe("TARGET_NOT_FOUND");
  });
});

describe("groundVisualTarget safety (CASE 13-18)", () => {
  it("CASE 13 — high confidence + low risk grounds cleanly", () => {
    viewport(640, 480);
    const button = buttonScene("Read more");
    hit(button);
    const res = groundVisualTarget(req({ label: "Read more" }));
    expect(res.ok).toBe(true);
    expect(res.riskLevel).toBe("LOW");
    expect(res.requiresConfirmation).toBe(false);
  });

  it("CASE 14 — high visual confidence never overrides high risk", () => {
    viewport(640, 480);
    const button = buttonScene("Buy now");
    hit(button);
    const res = groundVisualTarget(req({ label: "Buy now", visionConfidence: 0.99 }));
    expect(res.ok).toBe(false);
    expect(res.code).toBe("CONFIRMATION_REQUIRED");
    expect(res.riskLevel).toBe("HIGH");
  });

  it("CASE 15 — low vision confidence is rejected", () => {
    viewport(640, 480);
    const button = buttonScene();
    hit(button);
    const res = groundVisualTarget(req({ visionConfidence: 0.2 }));
    expect(res.ok).toBe(false);
    expect(res.code).toBe("LOW_CONFIDENCE");
  });

  it("CASE 16 — high vision confidence with low target agreement is rejected", () => {
    viewport(640, 480);
    const button = buttonScene();
    hit(button);
    const res = groundVisualTarget(req({ bbox: { x: 0, y: 0, width: 640, height: 480 }, visionConfidence: 0.9 }));
    expect(res.ok).toBe(false);
    expect(res.code).toBe("LOW_CONFIDENCE");
  });

  it("CASE 17 — drifted page is rejected, not executed", () => {
    viewport(640, 480);
    const button = buttonScene();
    hit(button);
    const res = groundVisualTarget(req({ url: "https://other.example/page" }));
    expect(res.ok).toBe(false);
    expect(res.code).toBe("STALE_CAPTURE");
  });

  it("CASE 18 — confirmation surfaces instead of executing", () => {
    viewport(640, 480);
    const button = buttonScene("Pay now");
    hit(button);
    const res = groundVisualTarget(req({ label: "Pay now", visionConfidence: 0.99 }));
    expect(res.ok).toBe(false);
    expect(res.code).toBe("CONFIRMATION_REQUIRED");
    expect(res.requiresConfirmation).toBe(true);
    expect(res.action).toBeUndefined();
  });
});

describe("visual end-to-end through the existing executor (CASE 36)", () => {
  it("VLM bbox grounds, executes via executeAction, and reports evidence", async () => {
    viewport(640, 480);
    const button = buttonScene();
    hit(button);
    const dispatched: string[] = [];
    vi.stubGlobal(
      "MouseEvent",
      class extends Event {
        constructor(type: string, init?: EventInit) {
          super(type, init);
          dispatched.push(type);
        }
      },
    );
    const res = await groundVisionPoint({
      bbox: { x: 300, y: 200, width: 100, height: 40 },
      image: { width: 640, height: 480 },
      confidence: 0.94,
      label: "Submit",
    });
    expect(res.ok).toBe(true);
    expect(res.execution?.ok).toBe(true);
    expect(dispatched).toEqual(["mousedown", "mouseup", "click"]);
    expect(res.grounding?.elementId).toMatch(/^el_/);
  });
});
