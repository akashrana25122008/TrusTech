/* ------------------------------------------------------------------ *
 * Starfield — a calm deep-space backdrop for the AI companion.
 *
 * Renderer-free construction (pure BufferGeometry + ShaderMaterial) so the
 * scene owns the render loop and React never re-renders per frame:
 * one Points draw call, per-star attributes, all animation in-shader.
 *
 * Each star carries randomized phase / frequency / amplitude / base
 * opacity / size, so twinkling is asynchronous and organic — never a
 * uniform blink. Twinkle = smooth product of two detuned sines, bounded
 * by a small per-star amplitude (no flashing).
 *
 * Palette is restrained (soft white, faint cyan/violet) and density is
 * biased toward the frame edges so the bot silhouette stays clean.
 * ------------------------------------------------------------------ */

import * as THREE from "three";

/** Deterministic PRNG (mulberry32) — stable layouts, testable output. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface StarfieldOptions {
  /** Total stars (bounded — a few hundred, never thousands). */
  count?: number;
  /** Spherical shell the stars live in (bot sits near the origin). */
  radiusMin?: number;
  radiusMax?: number;
  /** Seed for the layout. */
  seed?: number;
}

const VERT = /* glsl */ `
  attribute float aSize;
  attribute float aBase;
  attribute float aAmp;
  attribute float aPhase;
  attribute float aFreq;
  attribute vec3 aColor;
  uniform float uTime;
  uniform float uPixelRatio;
  uniform float uStill;
  uniform float uIntensity;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float dist = max(-mv.z, 0.001);
    gl_PointSize = aSize * uPixelRatio * (150.0 / dist);
    float s1 = sin(uTime * aFreq + aPhase) * 0.5 + 0.5;
    float s2 = sin(uTime * aFreq * 2.63 + aPhase * 1.71) * 0.5 + 0.5;
    float tw = s1 * s2;
    float a = mix(aBase + aAmp * tw, aBase, uStill);
    vAlpha = min(a, 1.0) * uIntensity;
    vColor = aColor;
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */ `
  precision mediump float;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vec2 uv = gl_PointCoord - vec2(0.5);
    float d = length(uv);
    float disc = smoothstep(0.5, 0.06, d);
    gl_FragColor = vec4(vColor, disc * vAlpha);
  }
`;

const TINTS = [
  new THREE.Color(0xe8f2ff), // soft white (majority)
  new THREE.Color(0xd8f4ff), // faint cyan
  new THREE.Color(0xe2e0ff), // faint violet
];

export interface Starfield {
  points: THREE.Points;
  /** Per-frame update: time seconds, state-driven intensity, still flag. */
  update(time: number, intensity: number, still: boolean): void;
  setPixelRatio(ratio: number): void;
  dispose(): void;
}

/**
 * Build the starfield. Distribution (~70% tiny / 20% small / 8% medium /
 * 2% accent), far shells dimmer + slower, silhouette corridor kept clean.
 */
export function createStarfield(options: StarfieldOptions = {}): Starfield {
  const { count = 1100, radiusMin = 7, radiusMax = 15, seed = 20260912 } = options;
  const rand = mulberry32(seed);

  const position = new Float32Array(count * 3);
  const aSize = new Float32Array(count);
  const aBase = new Float32Array(count);
  const aAmp = new Float32Array(count);
  const aPhase = new Float32Array(count);
  const aFreq = new Float32Array(count);
  const aColor = new Float32Array(count * 3);

  let placed = 0;
  let guard = 0;
  while (placed < count && guard++ < count * 40) {
    // Shell radius with cubic bias toward the far (dimmer) edge.
    const t = rand();
    const r = radiusMin + (radiusMax - radiusMin) * (0.25 + 0.75 * t * t);
    const theta = rand() * Math.PI * 2;
    const phi = Math.acos(2 * rand() - 1);
    const x = r * Math.sin(phi) * Math.cos(theta);
    const y = r * Math.cos(phi) * 0.72 + 0.9;
    const z = r * Math.sin(phi) * Math.sin(theta);
    // Keep the corridor in front of the bot silhouette clean; edges denser.
    if (Math.abs(x) < 1.7 && y > -0.9 && y < 2.7 && z > 1.5) continue;

    const depth = (r - radiusMin) / (radiusMax - radiusMin); // 0 near → 1 far
    const bucket = rand();
    const sizeClass = bucket < 0.7 ? 0 : bucket < 0.9 ? 1 : bucket < 0.98 ? 2 : 3;
    const sizeBase = [0.028, 0.05, 0.08, 0.12][sizeClass];
    const base = [0.42, 0.5, 0.6, 0.7][sizeClass] * (1 - depth * 0.38);
    const amp = (sizeClass === 3 ? 0.4 : 0.2 + sizeClass * 0.06) * (1 - depth * 0.3);

    position[placed * 3] = x;
    position[placed * 3 + 1] = y;
    position[placed * 3 + 2] = z;
    aSize[placed] = sizeBase * (0.8 + rand() * 0.45);
    aBase[placed] = Math.min(0.7, base * (0.75 + rand() * 0.5));
    aAmp[placed] = amp * (0.6 + rand() * 0.8);
    aPhase[placed] = rand() * Math.PI * 2;
    // Far stars breathe slower; all slow (periods of several seconds).
    aFreq[placed] = (0.22 + rand() * 0.5) * (1 - depth * 0.45);
    const tint = TINTS[rand() < 0.68 ? 0 : rand() < 0.5 ? 1 : 2];
    aColor[placed * 3] = tint.r;
    aColor[placed * 3 + 1] = tint.g;
    aColor[placed * 3 + 2] = tint.b;
    placed++;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
  geometry.setAttribute("aSize", new THREE.BufferAttribute(aSize, 1));
  geometry.setAttribute("aBase", new THREE.BufferAttribute(aBase, 1));
  geometry.setAttribute("aAmp", new THREE.BufferAttribute(aAmp, 1));
  geometry.setAttribute("aPhase", new THREE.BufferAttribute(aPhase, 1));
  geometry.setAttribute("aFreq", new THREE.BufferAttribute(aFreq, 1));
  geometry.setAttribute("aColor", new THREE.BufferAttribute(aColor, 3));

  const material = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      uTime: { value: 0 },
      uPixelRatio: { value: 1 },
      uStill: { value: 0 },
      uIntensity: { value: 1 },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const points = new THREE.Points(geometry, material);
  // A spread shell: never frustum-culled away as a whole by a tight bound.
  points.frustumCulled = false;
  points.renderOrder = -1;

  return {
    points,
    update(time: number, intensity: number, still: boolean): void {
      material.uniforms.uTime.value = time;
      material.uniforms.uIntensity.value = intensity;
      material.uniforms.uStill.value = still ? 1 : 0;
    },
    setPixelRatio(ratio: number): void {
      material.uniforms.uPixelRatio.value = ratio;
    },
    dispose(): void {
      geometry.dispose();
      material.dispose();
    },
  };
}
