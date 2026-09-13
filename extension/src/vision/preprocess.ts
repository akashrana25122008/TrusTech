import type { TransformersModule } from "./runtime";
import type { VisionRaster } from "./types";

export interface PreprocessedInput {
  pixel_values: unknown;
}

/**
 * Convert an RGBA raster to the model's pixel_values tensor using the exact
 * model processor (resize + normalize semantics come from the model's own
 * preprocessor_config.json, not a manual copy).
 */
export async function preprocessRaster(
  T: TransformersModule,
  raster: VisionRaster,
  processor: { (input: unknown): Promise<PreprocessedInput> },
): Promise<{ pixelValues: unknown; prepMs: number }> {
  const start = performance.now();
  const image = new T.RawImage(raster.data, raster.width, raster.height, 4);
  const out = await processor(image);
  return { pixelValues: out.pixel_values, prepMs: performance.now() - start };
}

/** Downscale an RGBA raster to the capture max edge (used by the panel before transfer). */
export function downscaleRaster(raster: VisionRaster, maxEdge: number): VisionRaster {
  const longest = Math.max(raster.width, raster.height);
  if (longest <= maxEdge) return raster;
  const scale = maxEdge / longest;
  const width = Math.max(1, Math.round(raster.width * scale));
  const height = Math.max(1, Math.round(raster.height * scale));
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const syc = ((y + 0.5) / height) * raster.height;
    const sy = Math.min(raster.height - 1, Math.floor(syc));
    for (let x = 0; x < width; x++) {
      const sxc = ((x + 0.5) / width) * raster.width;
      const sx = Math.min(raster.width - 1, Math.floor(sxc));
      const si = (sy * raster.width + sx) * 4;
      const di = (y * width + x) * 4;
      out[di] = raster.data[si];
      out[di + 1] = raster.data[si + 1];
      out[di + 2] = raster.data[si + 2];
      out[di + 3] = raster.data[si + 3];
    }
  }
  return { width, height, data: out };
}