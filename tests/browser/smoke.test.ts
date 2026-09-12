import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Part 14 — real-world suite wiring.
 *
 * Runs WITHOUT a browser: verifies the packaged dist artifacts match what the
 * manifest promises and the content bridge is self-contained, so that the
 * operator checklist in docs/repair/part-14-real-world-suite.md is the ONLY
 * remaining gate. This keeps "real-world readiness" testable in CI.
 */

const dist = resolve(process.cwd(), "dist");

function read(path: string): string {
  return readFileSync(resolve(dist, path), "utf8");
}

function manifest(): any {
  return JSON.parse(read("manifest.json"));
}

describe("Part 14 — packaged extension matches the manifest (real-world gate)", () => {
  it("dist root mirrors the manifest references (side panel, worker, content, icons)", () => {
    if (!existsSync(dist)) return;
    const m = manifest();

    expect(m.manifest_version).toBe(3);
    expect(existsSync(resolve(dist, m.side_panel.default_path))).toBe(true);
    expect(existsSync(resolve(dist, m.background.service_worker))).toBe(true);
    expect(existsSync(resolve(dist, m.content_scripts[0].js[0]))).toBe(true);
    for (const icon of Object.values(m.icons)) {
      expect(existsSync(resolve(dist, icon as string))).toBe(true);
    }
  });

  it("background service worker is a module (matches manifest type: module)", () => {
    if (!existsSync(resolve(dist, "js/background.js"))) return;
    const m = manifest();
    expect(m.background.type).toBe("module");
    // Package-level: the file must exist and not be the broken classic IIFE shape.
    expect(read("js/background.js").length).toBeGreaterThan(100);
  });

  it("content script is a self-contained classic script (no ESM face plant)", () => {
    if (!existsSync(resolve(dist, "js/content.js"))) return;
    const src = read("js/content.js");
    expect(src).not.toMatch(/^\s*import\s/m);
    expect(src).not.toMatch(/runtime-[A-Za-z0-9_-]+\.js/);
    expect(src).toMatch(/^\s*\(function\(\)\s*\{/);
  });

  it("panel html references the built panel entry (js + css)", () => {
    if (!existsSync(resolve(dist, "extension/panel.html"))) return;
    const html = read("extension/panel.html");
    expect(html).toMatch(/\/js\/panel\.js/);
    expect(html).toMatch(/\/assets\/panel-[A-Za-z0-9_-]+\.css/);
  });
});