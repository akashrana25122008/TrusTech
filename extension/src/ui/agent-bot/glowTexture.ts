/* Procedural canvas textures — exact port of the Interview Mentor
 * "AI interviewer" avatar's glow/disc textures. No external assets. */

import * as THREE from "three";

/** Soft radial glow texture (used for chest core + aux glows). */
export function createGlowTexture() {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;

  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, "rgba(163, 194, 255, 1)");
  gradient.addColorStop(0.28, "rgba(122, 162, 255, 0.7)");
  gradient.addColorStop(0.55, "rgba(99, 102, 241, 0.26)");
  gradient.addColorStop(1, "rgba(99, 102, 241, 0)");

  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

/** Soft-edged floor disc texture — opaque center fading to fully
 * transparent at the rim so the avatar's platform blends into the scene. */
export function createDiscTexture() {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;

  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, "rgba(10, 14, 32, 1)");
  gradient.addColorStop(0.72, "rgba(10, 14, 32, 1)");
  gradient.addColorStop(0.9, "rgba(10, 14, 32, 0.4)");
  gradient.addColorStop(1, "rgba(10, 14, 32, 0)");

  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}