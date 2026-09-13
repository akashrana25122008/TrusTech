import { describe, it, expect, vi } from "vitest";
import { groundVisionPoint } from "@/content/vision-bridge";

function viewport(w: number, h: number) {
  Object.defineProperty(window, "innerWidth", { value: w, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: h, configurable: true });
}

function stubElementFromPoint(value: Element | null) {
  Object.defineProperty(document, "elementFromPoint", {
    value: vi.fn().mockReturnValue(value),
    configurable: true,
    writable: true,
  });
}

describe("content/vision-bridge.ts", () => {
  it("grounds a vision point to a live button and clicks it", async () => {
    viewport(640, 480);
    document.body.innerHTML = `<main><button id="submit">Submit application</button></main>`;
    const button = document.getElementById("submit")!;
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, width: 120, height: 32, top: 0, left: 0, bottom: 32, right: 120, toJSON: () => {},
    } as DOMRect);
    const dispatched: string[] = [];
    vi.stubGlobal(
      "MouseEvent",
      class extends Event {
        constructor(type: string, init?: EventInit) {
          super(type, init);
          dispatched.push(type);
        }
      },
    );
    stubElementFromPoint(button);
    let clicked = false;
    button.addEventListener("click", () => {
      clicked = true;
    });
    const res = await groundVisionPoint({ point: { x: 320, y: 240 }, image: { width: 640, height: 480 }, confidence: 0.94 });
    expect(res.viewport).toEqual({ x: 320, y: 240 });
    expect(res.grounding?.status).toBe("ok");
    expect(res.ok).toBe(true);
    expect(clicked).toBe(true);
    expect(dispatched).toEqual(["mousedown", "mouseup", "click"]);
    expect(res.execution?.ok).toBe(true);
    vi.unstubAllGlobals();
  });

  it("rejects points outside the image", async () => {
    viewport(640, 480);
    const res = await groundVisionPoint({ point: { x: 9999, y: 10 }, image: { width: 640, height: 480 } });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("point outside image");
  });

  it("fails honestly when no element is at the point", async () => {
    viewport(640, 480);
    document.body.innerHTML = `<main></main>`;
    stubElementFromPoint(null);
    const res = await groundVisionPoint({ point: { x: 10, y: 10 }, image: { width: 640, height: 480 } });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("no element at point");
  });

  it("fails honestly when the element has no groundable identity", async () => {
    viewport(640, 480);
    document.body.innerHTML = `<main><div id="blank"></div></main>`;
    stubElementFromPoint(document.getElementById("blank"));
    const res = await groundVisionPoint({ point: { x: 10, y: 10 }, image: { width: 640, height: 480 } });
    expect(res.ok).toBe(false);
  });
});
