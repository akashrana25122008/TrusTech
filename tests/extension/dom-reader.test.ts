/**
 * Observation snapshot budgeting: content-first landmark ordering with the
 * backend contract cap (verified live: DOM-order truncation exposed only
 * header chrome on result pages, hiding every video link).
 */
import { describe, it, expect } from "vitest";
import { buildObservation, MAX_ELEMENTS } from "@/content/dom-reader";

describe("buildObservation ordering and budget", () => {
  it("matches the backend element cap", () => {
    // backend/app/schemas/step.py _MAX_ELEMENTS — the snapshot must always
    // fit the transmittable contract.
    expect(MAX_ELEMENTS).toBe(100);
  });

  it("orders main content before site chrome landmarks", () => {
    document.body.innerHTML =
      `<header><a href="/home">Home</a></header>` +
      `<main><a href="/watch?v=1">C Language Tutorial for Beginners</a></main>` +
      `<footer><a href="/about">About</a></footer>`;
    const snap = buildObservation(7);
    const names = snap.elements.map((e) => e.name);
    expect(names[0]).toContain("C Language Tutorial");
    expect(names).toContain("Home");
    expect(names).toContain("About");
  });

  it("keeps DOM order on pages without landmarks", () => {
    document.body.innerHTML = `<button>One</button><button>Two</button>`;
    const snap = buildObservation(7);
    expect(snap.elements.map((e) => e.name)).toEqual(["One", "Two"]);
  });

  it("caps oversized pages without dropping the count", () => {
    const links = Array.from({ length: 130 }, (_, i) => `<a href="/v${i}">Video number ${i} tutorial</a>`).join("");
    document.body.innerHTML = `<main>${links}</main>`;
    const snap = buildObservation(7);
    expect(snap.elements.length).toBeLessThanOrEqual(100);
    expect(snap.counted).toBeGreaterThanOrEqual(130);
  });
});
