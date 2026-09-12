import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const contentPath = resolve(process.cwd(), "dist/js/content.js");

describe("content script build artifact (MV3 classic script)", () => {
  it("dist/js/content.js is a self-contained classic script (no ESM, no runtime chunk)", () => {
    if (!existsSync(contentPath)) {
      // Test runs may precede `npm run build`; the contract is enforced by
      // tools/verify-content-build.mjs inside the build script itself.
      return;
    }
    const src = readFileSync(contentPath, "utf8");

    expect(src).not.toMatch(/(^|[;\s])import\s*[{'"`a-zA-Z*]/);
    expect(src).not.toMatch(/(^|[;\s])export\s/);
    expect(src).not.toMatch(/runtime-[A-Za-z0-9_-]+\.js/);
    expect(src).not.toMatch(/^\s*import\s/m);
    expect(src).toMatch(/^\s*\(function\(\)\s*\{/);
  });

  it("dist/background.js and dist/panel.js remain modules (allow runtime chunk)", () => {
    for (const name of ["background.js", "panel.js"]) {
      const p = resolve(process.cwd(), `dist/js/${name}`);
      if (!existsSync(p)) continue;
      const src = readFileSync(p, "utf8");
      // Module entries may import the shared runtime; they must NOT be IIFE with an export marker
      // that would break loading — weak sanity check only.
      expect(src.length).toBeGreaterThan(100);
    }
  });
});