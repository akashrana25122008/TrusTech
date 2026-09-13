import { describe, it, expect } from "vitest";
import { detectVisionCapabilities, pickBackend } from "@/vision/capability";
import { downscaleRaster } from "@/vision/preprocess";

const fakeScope = (overrides: { webgpu?: boolean; wasm?: boolean; ua?: string } = {}) => {
  const { webgpu = false, wasm = true, ua = "Chrome/126" } = overrides;
  return {
    navigator: { userAgent: ua, gpu: webgpu ? {} : undefined },
    WebAssembly: wasm ? { validate: () => true } : undefined,
  } as never;
};

describe("vision/capability — backend selection", () => {
  it("prefers webgpu when available and auto-selecting", () => {
    const caps = detectVisionCapabilities(fakeScope({ webgpu: true }));
    expect(caps.webgpu).toBe(true);
    if (typeof navigator !== "undefined" && !(navigator as unknown as { gpu?: unknown }).gpu) {
      // jsdom has no real GPU — capability reflects the injected scope, so webgpu detection is true only via scope
    }
    expect(pickBackend(caps, "auto")).toBe("webgpu");
  });

  it("falls back to wasm without webgpu, and cpu without wasm", () => {
    expect(pickBackend(detectVisionCapabilities(fakeScope({ webgpu: false, wasm: true })), "auto")).toBe("wasm");
    expect(pickBackend(detectVisionCapabilities(fakeScope({ webgpu: false, wasm: false })), "auto")).toBe("cpu");
  });

  it("honors an explicit preferred backend regardless of hardware", () => {
    const caps = detectVisionCapabilities(fakeScope({ webgpu: true }));
    expect(pickBackend(caps, "cpu")).toBe("cpu");
    expect(pickBackend(caps, "wasm")).toBe("wasm");
  });

  it("detects the browser host from the user agent", () => {
    expect(detectVisionCapabilities(fakeScope({ ua: "Mozilla/5.0 (X11; Linux x86_64; rv:126.0) Gecko/20100101 Firefox/126.0" })).host).toBe("firefox");
    expect(detectVisionCapabilities(fakeScope({ ua: "Chrome/126" })).host).toBe("chrome");
  });
});

describe("vision/preprocess — raster downscale", () => {
  it("returns raster unchanged when already within max edge", () => {
    const raster = { width: 100, height: 80, data: new Uint8ClampedArray(100 * 80 * 4) };
    const out = downscaleRaster(raster, 1333);
    expect(out).toBe(raster);
  });

  it("downscales proportionally and preserves aspect ratio", () => {
    const raster = { width: 1600, height: 900, data: new Uint8ClampedArray(1600 * 900 * 4) };
    // Fill with a constant color; every downscaled pixel must sample that color.
    for (let i = 0; i < raster.data.length; i += 4) {
      raster.data[i] = 200;
      raster.data[i + 1] = 100;
      raster.data[i + 2] = 50;
      raster.data[i + 3] = 255;
    }
    const out = downscaleRaster(raster, 800);
    expect(out.width).toBe(800);
    expect(out.height).toBe(450);
    expect(out.data).toHaveLength(800 * 450 * 4);
    expect(out.data[0]).toBe(200);
    expect(out.data[1]).toBe(100);
    expect(out.data[2]).toBe(50);
    expect(out.data[3]).toBe(255);
  });
});