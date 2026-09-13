import { downscaleRaster } from "./preprocess";
import type { VisionRaster } from "./types";

export interface CaptureResult {
  raster: VisionRaster;
  sourceWidth: number;
  sourceHeight: number;
  captureMs: number;
  dataUrl: string;
}

type CaptureFn = (options?: { format?: string }) => Promise<string>;

function defaultCaptureFn(): CaptureFn {
  return (options) =>
    new Promise<string>((resolve, reject) => {
      const chromeGlobal = (globalThis as never as {
        chrome?: { tabs?: { captureVisibleTab?: (opts: unknown, cb: (d: string) => void) => void } };
      }).chrome;
      if (!chromeGlobal?.tabs?.captureVisibleTab) {
        reject(new Error("chrome.tabs.captureVisibleTab is unavailable"));
        return;
      }
      chromeGlobal.tabs.captureVisibleTab({ format: options?.format ?? "png" }, (dataUrl) => resolve(dataUrl));
    });
}

export async function dataUrlToRaster(dataUrl: string): Promise<VisionRaster> {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0);
  const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  bitmap.close();
  return { width: bitmap.width, height: bitmap.height, data: imageData.data };
}

export async function captureActiveTab(
  maxEdge = 1333,
  capture: CaptureFn = defaultCaptureFn(),
): Promise<CaptureResult> {
  const start = performance.now();
  const dataUrl = await capture({ format: "png" });
  const full = await dataUrlToRaster(dataUrl);
  const raster = downscaleRaster(full, maxEdge);
  return {
    raster,
    sourceWidth: full.width,
    sourceHeight: full.height,
    captureMs: performance.now() - start,
    dataUrl,
  };
}