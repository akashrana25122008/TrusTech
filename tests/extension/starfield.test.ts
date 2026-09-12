/**
 * Starfield — renderer-free geometry/parameter tests (no WebGL needed).
 * Visual motion itself is shader-side; these pin the distribution,
 * restraint, determinism, and lifecycle contracts.
 */
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { createStarfield, mulberry32, STAR_COUNT_DEFAULT, STAR_COUNT_LOW, BRIGHTNESS_MULTIPLIER } from "@/ui/agent-bot/starfield";

function attr(geo: THREE.BufferGeometry, name: string): number[] {
  return Array.from((geo.getAttribute(name) as THREE.BufferAttribute).array as Float32Array);
}

describe("starfield", () => {
  it("builds the requested number of stars with full attribute sets", () => {
    const sf = createStarfield({ count: 240, seed: 7 });
    const geo = sf.points.geometry;
    expect(geo.getAttribute("position").count).toBe(240);
    for (const name of ["aSize", "aBase", "aAmp", "aPhase", "aFreq"]) {
      expect(geo.getAttribute(name).count).toBe(240);
    }
    expect(geo.getAttribute("aColor").count).toBe(240);
    expect(sf.points.frustumCulled).toBe(false);
    const mat = sf.points.material as THREE.ShaderMaterial;
    expect(mat.blending).toBe(THREE.AdditiveBlending);
    expect(mat.transparent).toBe(true);
    expect(mat.depthWrite).toBe(false);
    sf.dispose();
  });

  it("keeps sizes, opacities, and frequencies in calm ranges", () => {
    const sf = createStarfield({ count: 300, seed: 11 });
    const geo = sf.points.geometry;
    for (const s of attr(geo, "aSize")) expect(s).toBeGreaterThan(0), expect(s).toBeLessThan(0.2);
    for (const b of attr(geo, "aBase")) expect(b).toBeGreaterThanOrEqual(0), expect(b).toBeLessThanOrEqual(0.95);
    for (const a of attr(geo, "aAmp")) expect(a).toBeGreaterThanOrEqual(0), expect(a).toBeLessThanOrEqual(0.65);
    for (const f of attr(geo, "aFreq")) expect(f).toBeGreaterThan(0), expect(f).toBeLessThanOrEqual(0.75);
    for (const p of attr(geo, "aPhase")) expect(p).toBeGreaterThanOrEqual(0), expect(p).toBeLessThanOrEqual(Math.PI * 2);
    sf.dispose();
  });

  it("follows roughly 70/20/8/2 size classes with few accent stars", () => {
    const sf = createStarfield({ count: 1000, seed: 21 });
    const sizes = attr(sf.points.geometry, "aSize");
    const tiny = sizes.filter((s) => s < 0.045).length;
    const accent = sizes.filter((s) => s >= 0.09).length;
    expect(tiny / sizes.length).toBeGreaterThan(0.55);
    expect(accent / sizes.length).toBeLessThan(0.08);
    sf.dispose();
  });

  it("keeps colors restrained (near-white, no saturated hues)", () => {
    const sf = createStarfield({ count: 200, seed: 33 });
    const cols = attr(sf.points.geometry, "aColor");
    // THREE.Color stores linear values — compare back in sRGB.
    const toSrgb = (c: number) => Math.pow(c, 1 / 2.2);
    for (let i = 0; i < cols.length; i += 3) {
      const [r, g, b] = [toSrgb(cols[i]), toSrgb(cols[i + 1]), toSrgb(cols[i + 2])];
      expect(Math.min(r, g, b)).toBeGreaterThan(0.8);
      expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThan(0.2);
    }
    sf.dispose();
  });

  it("is deterministic per seed and keeps the bot corridor sparse", () => {
    const a = createStarfield({ count: 240, seed: 99 });
    const b = createStarfield({ count: 240, seed: 99 });
    expect(attr(a.points.geometry, "position")).toEqual(attr(b.points.geometry, "position"));
    const pos = attr(a.points.geometry, "position");
    let central = 0;
    for (let i = 0; i < pos.length; i += 3) {
      const [x, y, z] = [pos[i], pos[i + 1], pos[i + 2]];
      if (Math.abs(x) < 1.7 && y > -0.9 && y < 2.7 && z > 1.5) central++;
    }
    expect(central / 240).toBeLessThan(0.15);
    a.dispose();
    b.dispose();
  });

  it("update/dispose run without a renderer (uniform-only, no GL)", () => {
    const sf = createStarfield({ count: 10, seed: 5 });
    expect(() => {
      sf.setPixelRatio(2);
      sf.update(1.5, 1.0, false);
      sf.update(99.0, 0.5, true);
      sf.dispose();
    }).not.toThrow();
  });

  it("ships 2× density with a brightness lift by default", () => {
    expect(STAR_COUNT_DEFAULT).toBe(2200);
    expect(STAR_COUNT_LOW).toBe(1040);
    expect(BRIGHTNESS_MULTIPLIER).toBeGreaterThan(1);
    const sf = createStarfield({ seed: 7 });
    expect(sf.points.geometry.getAttribute("position").count).toBe(STAR_COUNT_DEFAULT);
    const bases = attr(sf.points.geometry, "aBase");
    const mean = bases.reduce((m, b) => m + b, 0) / bases.length;
    // Lifted well above the old ~0.4 dim average, still under the cap.
    expect(mean).toBeGreaterThan(0.55);
    expect(Math.max(...bases)).toBeLessThanOrEqual(0.95);
    sf.dispose();
  });

  it("mulberry32 is stable", () => {
    const r1 = mulberry32(42);
    const r2 = mulberry32(42);
    expect([r1(), r1(), r1()]).toEqual([r2(), r2(), r2()]);
  });
});
