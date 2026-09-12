import { describe, it, expect } from "vitest";
import { TransformersVisionProvider, detectCapabilities, getVisionProvider } from "@/vision/providers";

describe("Part 16 — vision capability detection", () => {
  it("reports wasm baseline and no remote backends in a bare runtime", () => {
    const caps = detectCapabilities();
    // Node/jsdom: WebAssembly exists, WebGPU/transformers/onnx do not.
    expect(caps.wasm).toBe(true);
    expect(caps.webgpu).toBe(false);
    expect(caps.transformers).toBe(false);
    expect(caps.onnx).toBe(false);
    expect(caps.backend).toBe("wasm");
  });

  it("selects the transformers provider only when the global exists", () => {
    const prev = (globalThis as any).transformers;
    (globalThis as any).transformers = {};
    try {
      const provider = getVisionProvider();
      expect(provider).toBeInstanceOf(TransformersVisionProvider);
      expect(provider?.name).toBe("transformers.js");
    } finally {
      if (prev === undefined) delete (globalThis as any).transformers;
      else (globalThis as any).transformers = prev;
    }
  });

  it("returns null when no provider is available and none is forced", () => {
    expect(getVisionProvider()).toBeNull();
  });

  it("transformers provider reports not-ready without the global (no fake success)", async () => {
    const provider = new TransformersVisionProvider();
    expect(await provider.ready()).toBe(false);
    // Viewport description never fabricates output without VL weights.
    expect(await provider.describeViewport()).toBeNull();
  });
});

describe("Part 16 — DOM-based interactive detection (local baseline)", () => {
  it("detects links, buttons, inputs and selects with a visible rect", async () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <a id="l1" href="/x">First link</a>
      <button id="b1">Go</button>
      <input id="i1" name="query" type="search">
      <select id="s1"><option>One</option></select>
      <span id="hidden-el">hidden</span>
    `;
    for (const id of ["l1", "b1", "i1", "s1"]) {
      const el = root.querySelector(`#${id}`)!;
      (el as HTMLElement).getBoundingClientRect = () =>
        ({ width: 30, height: 20, top: 0, left: 0, right: 30, bottom: 20, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    }
    const span = root.querySelector("#hidden-el") as HTMLElement;
    span.getBoundingClientRect = () =>
      ({ width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;

    const provider = new TransformersVisionProvider();
    const found = await provider.detectInteractive(root);

    const labels = found.map((e) => e.kind).sort();
    expect(labels).toEqual(["button", "input", "link", "select"]);
    const input = found.find((e) => e.kind === "input");
    expect(input?.selector).toBe("#i1");
  });
});