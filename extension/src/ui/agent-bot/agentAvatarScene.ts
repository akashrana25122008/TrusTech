/* ------------------------------------------------------------------ *
 * AgentBot scene — the primary AI companion.
 *
 * This is a faithful imperative port of the Interview Mentor "AI
 * interviewer" avatar (AIAvatar.tsx + AvatarScene.tsx + ParticleField
 * lite preset), adapted to the side-panel extension environment:
 *   • same holographic bust geometry, materials, colors and glows
 *   • the original idle float + pointer-follow rig
 *   • a damped BotState → motion state machine so the bot visibly
 *     reacts to the browser agent (observe / think / act / wait /
 *     success / error / paused)
 *   • no post-processing, modest particle count, full disposal —
 *     extension-friendly rendering
 * ------------------------------------------------------------------ */

import * as THREE from "three";
import type { BotState } from "./types";
import { createGlowTexture, createDiscTexture } from "./glowTexture";
import { createStarfield } from "./starfield";

const CYAN = new THREE.Color(0x3fd8ff);
const VIOLET = new THREE.Color(0x8b7bff);
const GREEN = new THREE.Color(0x4ce3a4);
const WARM = new THREE.Color(0xff6b3d);

interface Motion {
  floatAmp: number;
  headTiltX: number;
  headTiltZ: number;
  turnY: number;
  glow: number;
  scan: number;
  spin: number;
  energy: number;
  success: number;
  warn: number;
}

const MODES: Record<BotState, Motion> = {
  idle:      { floatAmp: 0.18, headTiltX: 0.04,  headTiltZ: 0.025, turnY: 0,    glow: 0.5,  scan: 0,    spin: 0.8,  energy: 0,   success: 0, warn: 0 },
  observing: { floatAmp: 0.085, headTiltX: -0.18, headTiltZ: 0, turnY: 0.5,  glow: 0.7,  scan: 0.75, spin: 1.7,  energy: 0.35, success: 0, warn: 0 },
  thinking:  { floatAmp: 0.06,  headTiltX: 0.3,   headTiltZ: 0.15, turnY: 0,    glow: 1.0,  scan: 1,    spin: 2.6,  energy: 0.15, success: 0, warn: 0 },
  acting:    { floatAmp: 0.15,  headTiltX: -0.08, headTiltZ: -0.05, turnY: -0.55, glow: 0.9,  scan: 0.4,  spin: 2.1,  energy: 0.8,  success: 0, warn: 0 },
  waiting:   { floatAmp: 0.14,  headTiltX: 0.02,  headTiltZ: 0.02, turnY: 0,    glow: 0.55, scan: 0.18, spin: 0.55, energy: 0,   success: 0, warn: 0 },
  success:   { floatAmp: 0.1,   headTiltX: 0,     headTiltZ: 0,    turnY: 0,    glow: 1.2,  scan: 0.25, spin: 1.3,  energy: 0,   success: 1, warn: 0 },
  paused:    { floatAmp: 0.03,  headTiltX: 0.02,  headTiltZ: 0,    turnY: 0,    glow: 0.28, scan: 0,    spin: 0.15, energy: 0,   success: 0, warn: 0 },
  error:     { floatAmp: 0.04,  headTiltX: 0.13,  headTiltZ: 0.06, turnY: 0,    glow: 0.35, scan: 0.45, spin: 0,    energy: 0,   success: 0, warn: 1 },
};

const TORSO_PROFILE: Array<[number, number]> = [
  [0.02, 0.0],
  [0.42, 0.02],
  [0.52, 0.2],
  [0.56, 0.55],
  [0.62, 0.78],
  [0.6, 0.92],
  [0.3, 1.02],
  [0.27, 1.1],
];

export interface AgentBotSceneHandle {
  setMode(mode: BotState): void;
  setPointer(nx: number, ny: number): void;
  dispose(): void;
}

export function createAgentBotScene(container: HTMLElement, lowQuality: boolean): AgentBotSceneHandle {
  let width = container.clientWidth || 360;
  let height = container.clientHeight || 300;

  const renderer = new THREE.WebGLRenderer({ antialias: !lowQuality, alpha: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, lowQuality ? 1 : 1.5));
  renderer.setSize(width, height);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = null;

  const camera = new THREE.PerspectiveCamera(42, width / Math.max(height, 1), 0.1, 60);
  camera.position.set(0, 0.55, 6.2);

  /* ---- lights (reference AvatarScene rig, decay = physical) ---- */
  const ambient = new THREE.AmbientLight(0xaab8ff, 0.55);
  scene.add(ambient);
  const key = new THREE.DirectionalLight(0xcfd8ff, 1.4);
  key.position.set(3, 5, 4);
  scene.add(key);
  const rim = new THREE.PointLight(0x6d5bff, 16, 18);
  rim.position.set(-4, 2, -2);
  scene.add(rim);
  const fill = new THREE.PointLight(0x3fd8ff, 6, 12);
  fill.position.set(2, -1, 3);
  scene.add(fill);

  /* ---- textures ---- */
  const glowTex = createGlowTexture();
  const discTex = createDiscTexture();

  /* ---- materials (reference AIAvatar) ---- */
  const suitMat = new THREE.MeshPhysicalMaterial({ color: 0x151a33, metalness: 0.5, roughness: 0.42, clearcoat: 0.35 });
  const darkMat = new THREE.MeshPhysicalMaterial({ color: 0x10152c, metalness: 0.6, roughness: 0.3, clearcoat: 0.4 });
  const armMat = new THREE.MeshPhysicalMaterial({ color: 0x11152e, metalness: 0.55, roughness: 0.4 });
  const collarMat = new THREE.MeshStandardMaterial({ color: 0x2b3a6e, metalness: 0.8, roughness: 0.25, emissive: 0x1d2c5e, emissiveIntensity: 0.6 });
  const headMat = new THREE.MeshPhysicalMaterial({ color: 0x1a2140, metalness: 0.72, roughness: 0.18, clearcoat: 0.9, clearcoatRoughness: 0.12 });
  const neckMat = new THREE.MeshPhysicalMaterial({ color: 0x12172f, metalness: 0.6, roughness: 0.3, clearcoat: 0.5 });

  const visorMat = new THREE.MeshBasicMaterial({ color: CYAN.clone(), transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending });
  const accentMat = new THREE.MeshBasicMaterial({ color: 0x4f7cff, transparent: true, opacity: 0.55 });
  const seamMat = new THREE.MeshBasicMaterial({ color: 0x3f6dff });
  const seamMatSoft = new THREE.MeshBasicMaterial({ color: 0x5a7dff, transparent: true, opacity: 0.65 });
  const coreMat = new THREE.MeshBasicMaterial({ color: 0x9dbcff });
  const scanlineMat = new THREE.MeshBasicMaterial({ color: 0x8ab4ff, transparent: true, opacity: 0.35 });

  /* ---- world: outer group mirrors AIAvatar's [0,-0.5,0] root ---- */
  const root = new THREE.Group();
  root.position.set(0, -0.5, 0);
  scene.add(root);

  /* ground platform + feathered ring (reference) */
  const platform = new THREE.Mesh(
    new THREE.CircleGeometry(1.85, 64),
    new THREE.MeshStandardMaterial({ color: 0x0a0e20, map: discTex, transparent: true, opacity: 0.92, metalness: 0.7, roughness: 0.35 }),
  );
  platform.rotation.x = -Math.PI / 2;
  platform.position.y = 0.01;
  root.add(platform);

  const groundRing = new THREE.Mesh(
    new THREE.RingGeometry(1.4, 1.44, 64),
    new THREE.MeshBasicMaterial({ color: 0x5a7dff, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
  );
  groundRing.rotation.x = Math.PI / 2;
  groundRing.position.y = 0.05;
  root.add(groundRing);

  /* ---- character group (the reference's drei <Float>) ---- */
  const float = new THREE.Group();
  root.add(float);

  // torso lathe
  const torsoPts: THREE.Vector2[] = TORSO_PROFILE.map(([r, y]) => new THREE.Vector2(r, y));
  const torsoGeo = new THREE.LatheGeometry(torsoPts, 48);
  const torso = new THREE.Mesh(torsoGeo, suitMat);
  torso.position.y = 0.1;
  float.add(torso);

  // chest accent seams
  const seam1 = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.02, 0.02), seamMat);
  seam1.position.set(0, 0.7, 0.41);
  seam1.rotation.set(0.1, 0, 0);
  float.add(seam1);
  const seam2 = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.015, 0.015), seamMatSoft);
  seam2.position.set(0, 0.58, 0.44);
  seam2.rotation.set(0.16, 0.3, 0);
  float.add(seam2);

  // chest AI core + glow sprite
  const chestCore = new THREE.Mesh(new THREE.SphereGeometry(0.07, 24, 24), coreMat);
  chestCore.position.set(0, 0.5, 0.46);
  float.add(chestCore);
  const chestSprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: glowTex, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  chestSprite.position.set(0, 0.5, 0.6);
  chestSprite.scale.set(0.5, 0.5, 1);
  float.add(chestSprite);

  // shoulders
  for (const side of [-1, 1]) {
    const s = new THREE.Mesh(new THREE.SphereGeometry(0.11, 24, 24), darkMat);
    s.position.set(side * 0.64, 0.9, 0);
    float.add(s);
  }
  // upper arms
  for (const side of [-1, 1]) {
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.09, 0.5, 20), armMat);
    arm.position.set(side * 0.7, 0.68, 0.02);
    arm.rotation.set(0.12, 0, side * -0.5);
    float.add(arm);
  }

  // collar + neck
  const collar = new THREE.Mesh(new THREE.TorusGeometry(0.28, 0.024, 12, 40), collarMat);
  collar.position.y = 1.1;
  collar.rotation.x = Math.PI / 2;
  float.add(collar);
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.115, 0.13, 0.16, 28), neckMat);
  neck.position.y = 1.16;
  float.add(neck);

  // head
  const head = new THREE.Group();
  head.position.y = 1.46;
  float.add(head);

  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.31, 48, 48), headMat);
  skull.scale.set(1.04, 1.18, 0.96);
  head.add(skull);

  const visor = new THREE.Mesh(new THREE.TorusGeometry(0.26, 0.012, 10, 40, Math.PI), visorMat);
  visor.position.set(0, 0.02, 0.2);
  visor.rotation.set(0.18, 0, 0);
  head.add(visor);

  for (const side of [-1, 1]) {
    const cheek = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.015, 0.012), accentMat);
    cheek.position.set(side * 0.18, -0.09, 0.16);
    cheek.rotation.set(0.3, side * 0.1, 0);
    head.add(cheek);
  }

  const micDot = new THREE.Mesh(new THREE.SphereGeometry(0.012, 12, 12), new THREE.MeshBasicMaterial({ color: 0x8ab4ff }));
  micDot.position.set(0, -0.12, 0.19);
  head.add(micDot);

  // thin scan line across the body
  const scanline = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.006, 0.006), scanlineMat);
  scanline.position.set(0, 0.55, 0.357);
  scanline.rotation.set(0.05, 0, 0);
  float.add(scanline);

  /* ---- state aura (perception halo around the head) ---- */
  const auraMat = new THREE.MeshBasicMaterial({ color: 0x8b7bff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  const aura = new THREE.Mesh(new THREE.TorusGeometry(0.8, 0.012, 12, 80), auraMat);
  aura.position.y = 1.9;
  aura.rotation.x = Math.PI / 2.25;
  root.add(aura);

  const successMat = new THREE.MeshBasicMaterial({ color: 0x4ce3a4, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  const successHalo = new THREE.Mesh(new THREE.TorusGeometry(0.98, 0.02, 12, 80), successMat);
  successHalo.position.y = 1.2;
  root.add(successHalo);

  /* ---- particle field (reference lite preset: 40 pts) ---- */
  const particleCount = lowQuality ? 24 : 40;
  const positions = new Float32Array(particleCount * 3);
  for (let i = 0; i < particleCount; i++) {
    const r = 4.6 * Math.pow(Math.random(), 0.42);
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.cos(phi) * 0.72 + 0.8;
    positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
  }
  const particleGeo = new THREE.BufferGeometry();
  particleGeo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const particleMat = new THREE.PointsMaterial({
    color: 0x6f8cff,
    size: 0.028,
    transparent: true,
    opacity: 0.65,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
  });
  const particles = new THREE.Points(particleGeo, particleMat);
  root.add(particles);

  /* ---- deep-space starfield: one Points draw call, per-star twinkle in
     shader (see starfield.ts). Atmospheric only — the bot stays the hero.
     Intensity follows the ALREADY state-driven glow, so stars never fake
     agent activity; they merely breathe with the real mode. */
  const starfield = createStarfield({ count: lowQuality ? 520 : 1100 });
  starfield.setPixelRatio(renderer.getPixelRatio());
  scene.add(starfield.points);

  /* ---- state machine ---- */
  const motion: Motion = { ...MODES.idle };
  let mode: BotState = "idle";
  let modeSetAt = 0;
  let nxp = 0;
  let nyp = 0;
  let disposed = false;

  const clock = new THREE.Clock();
  let raf = 0;

  const ease = (dt: number) => 1 - Math.exp(-6.5 * dt);
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

  function animate() {
    if (disposed) return;
    raf = requestAnimationFrame(animate);
    const dt = Math.min(clock.getDelta(), 0.05);
    const now = clock.elapsedTime;

    // Success is a short transition, not a standing state: after ~3.5 s the
    // motion targets ease back toward calm idle while the agent STATUS
    // (pill, action line, drawer) keeps reporting COMPLETED truthfully.
    let target = MODES[mode];
    if (mode === "success") {
      const t = Math.min(1, Math.max(0, (now - modeSetAt) / 3.5));
      const e = t * t * (3 - 2 * t);
      if (e > 0) {
        const from = MODES.success;
        const to = MODES.idle;
        target = {
          floatAmp: lerp(from.floatAmp, to.floatAmp, e),
          headTiltX: lerp(from.headTiltX, to.headTiltX, e),
          headTiltZ: lerp(from.headTiltZ, to.headTiltZ, e),
          turnY: lerp(from.turnY, to.turnY, e),
          glow: lerp(from.glow, to.glow, e),
          scan: lerp(from.scan, to.scan, e),
          spin: lerp(from.spin, to.spin, e),
          energy: lerp(from.energy, to.energy, e),
          success: lerp(from.success, to.success, e),
          warn: lerp(from.warn, to.warn, e),
        };
      }
    }
    const k = ease(dt);
    for (const key of Object.keys(motion) as (keyof Motion)[]) {
      motion[key] += (target[key] - motion[key]) * k;
    }
    if (mode !== "success") motion.success *= Math.exp(-1.1 * dt);

    const paused = mode === "paused";
    const ts = (paused ? 0.25 : 1) * (lowQuality ? 0.7 : 1);

    /* pointer rig + turn (observing/acting) — reference <Rig> */
    const turnTarget = Math.sin(now * 0.35 * ts) * 0.05 + motion.turnY + nxp * 0.18;
    root.rotation.y += (turnTarget - root.rotation.y) * k;
    root.rotation.x += ((-nyp * 0.07) - root.rotation.x) * (paused ? 0.012 : 0.03);

    /* idle float — reference drei <Float speed=1.6 floatIntensity=0.35> */
    float.position.y = Math.sin(now * 1.6 * ts) * motion.floatAmp;
    float.rotation.x = Math.sin(now * 1.2 * ts) * 0.04 * motion.floatAmp * 6;
    float.rotation.z = Math.cos(now * 0.9 * ts) * 0.035 * motion.floatAmp * 6;

    /* head micro motion + thinking/acting energy */
    const wiggle = motion.energy * Math.sin(now * 16) * 0.02;
    head.rotation.x = Math.sin(now * 0.9 * ts) * 0.04 + motion.headTiltX + wiggle;
    head.rotation.z = motion.headTiltZ + Math.sin(now * 0.7 * ts) * 0.03 - wiggle;

    /* glow pulse — chest core + sprite */
    const pulse = 0.85 + Math.sin(now * 2.2 * ts) * 0.15;
    const boost = motion.success > 0.05 ? motion.success * 2.2 : 0;
    const warn = motion.warn;
    chestSprite.material.opacity = (0.45 + motion.glow * 0.5 + boost) * pulse;
    chestSprite.scale.setScalar((0.5 + motion.glow * 0.22) * pulse);
    (coreMat.color as THREE.Color).copy(CYAN).lerp(WARM, warn * 0.7).lerp(GREEN, boost * 0.4);

    /* visor hue — cyan base, violet thinking, warm error, green success */
    const vTarget = warn > 0.4 ? WARM : boost > 0.25 ? GREEN : mode === "thinking" ? VIOLET : CYAN;
    visorMat.color.lerp(vTarget, 1 - Math.exp(-4 * dt));
    visorMat.opacity = 0.6 + motion.glow * 0.4;

    /* aura ring (observing / thinking) */
    auraMat.opacity = Math.min(0.6, motion.scan * 0.5) + Math.sin(now * 4 * ts) * 0.08;
    aura.rotation.z += dt * ts * (0.5 + motion.spin * 0.4);
    (auraMat.color as THREE.Color).copy(vTarget).lerp(VIOLET, 0.35);

    /* success halo */
    const s = motion.success;
    if (s > 0.01) {
      successHalo.visible = true;
      const sc = 1 + (1 - Math.exp(-3.2 * s)) * 1.6;
      successHalo.scale.setScalar(sc);
      successMat.opacity = Math.max(0, s * (1 - s * 0.8));
    } else {
      successHalo.visible = false;
    }

    /* particles — reference drift + pointer influence */
    particles.rotation.y = now * 0.02 * ts + motion.spin * 0.01 + nxp * 0.12;
    particles.rotation.x = THREE.MathUtils.lerp(particles.rotation.x, -nyp * 0.06, paused ? 0.01 : 0.03);
    particleMat.opacity = 0.4 + motion.glow * 0.28;

    /* starfield — calm asynchronous twinkle; subtle state coupling only */
    const starIntensity = Math.min(
      (0.9 + motion.glow * 0.4 + motion.success * 0.45) * (1 - motion.warn * 0.3),
      1.3,
    );
    starfield.update(now, starIntensity, lowQuality || paused);

    /* camera parallax */
    camera.position.x += (nxp * 0.35 - camera.position.x) * k;
    camera.position.y += (0.55 - nyp * 0.25 - camera.position.y) * k;
    camera.lookAt(0, -0.1, 0);

    /* resize */
    const rw = container.clientWidth;
    const rh = container.clientHeight;
    if (rw && rh && (rw !== width || rh !== height)) {
      width = rw;
      height = rh;
      renderer.setSize(width, height);
      camera.aspect = width / Math.max(height, 1);
      camera.updateProjectionMatrix();
    }

    if (typeof document !== "undefined" && document.visibilityState !== "hidden") {
      renderer.render(scene, camera);
    }
  }

  animate();

  return {
    setMode(m: BotState) {
      if (m !== mode) {
        mode = m;
        modeSetAt = clock.elapsedTime;
      }
    },
    setPointer(nx: number, ny: number) {
      nxp = Math.max(-1, Math.min(1, nx));
      nyp = Math.max(-1, Math.min(1, ny));
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      starfield.dispose();
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else if (mat) mat.dispose();
      });
      const mat = particles.material as THREE.Material;
      mat.dispose();
      particleGeo.dispose();
      glowTex.dispose();
      discTex.dispose();
      renderer.dispose();
      if (renderer.domElement.parentElement === container) {
        container.removeChild(renderer.domElement);
      }
    },
  };
}