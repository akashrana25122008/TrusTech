/**
 * Render quiescence: CTX_OBSERVE waits for the DOM to stop mutating
 * (bounded) so the planner never decides on a half-painted page.
 */
import { describe, it, expect } from "vitest";
import { PageObserver } from "@/content/observer";

describe("PageObserver.settled", () => {
  it("resolves true once the page is quiet", async () => {
    const obs = new PageObserver(() => undefined);
    obs.start(-1);
    document.body.innerHTML = `<div id="a">steady content</div>`;
    const t0 = Date.now();
    const ok = await obs.settled(200, 2000);
    const dt = Date.now() - t0;
    expect(ok).toBe(true);
    // One quiet window was awaited (not instant, not the full cap).
    expect(dt).toBeGreaterThanOrEqual(150);
    expect(dt).toBeLessThan(1500);
    obs.stop();
  });

  it("waits through bursts of mutations, then resolves", async () => {
    const obs = new PageObserver(() => undefined);
    obs.start(-1);
    document.body.innerHTML = `<div id="a">v0</div>`;
    const el = document.querySelector("#a")!;
    const burst = window.setInterval(() => {
      el.textContent = `v${Math.random()}`;
    }, 100);
    // Cap forces return while still mutating.
    const capped = await obs.settled(600, 700);
    expect(capped).toBe(false);
    window.clearInterval(burst);
    // Quiet again → resolves true.
    const ok = await obs.settled(200, 2000);
    expect(ok).toBe(true);
    obs.stop();
  });

  it("observe() still returns a usable snapshot after settling", async () => {
    const obs = new PageObserver(() => undefined);
    obs.start(-1);
    document.body.innerHTML = `<button>Go</button>`;
    await obs.settled(100, 1000);
    const { snapshot } = obs.observe();
    // jsdom has no innerText — assert on the indexed element instead.
    expect(snapshot.elements.some((e) => e.name === "Go")).toBe(true);
    obs.stop();
  });
});
