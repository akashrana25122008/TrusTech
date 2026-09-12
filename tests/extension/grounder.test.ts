import { describe, it, expect, beforeEach } from "vitest";
import { indexAll, resolveId, isLive, idOf, clearIndex } from "@/content/indexer";
import { groundTarget } from "@/content/grounder";
import { buildObservation } from "@/content/dom-reader";
import { executeAction } from "@/content/executor";
import { PageObserver } from "@/content/observer";

beforeEach(() => {
  document.body.innerHTML = "";
  clearIndex();
  // jsdom returns zero rects — give every element a size so visibility works.
  Object.defineProperty(Element.prototype, "getBoundingClientRect", {
    configurable: true,
    value() {
      return { x: 0, y: 0, width: 100, height: 20, left: 0, top: 0, right: 100, bottom: 20, toJSON: () => ({}) };
    },
  });
});

describe("indexer", () => {
  it("indexes interactive elements in DOM order with el_NNN ids", () => {
    document.body.innerHTML = `
      <button>Search</button>
      <input type="search" placeholder="Query">
      <a href="/x">Link</a>`;
    const els = indexAll(document);
    expect(els.length).toBe(3);
    expect(els[0].textContent).toBe("Search");
  });

  it("resolveId / isLive track the live document", () => {
    document.body.innerHTML = `<button id="b">Go</button>`;
    const [b] = indexAll(document);
    const id = idOf(b)!;
    expect(id.startsWith("el_")).toBe(true);
    expect(resolveId(id)).toBe(b);
    expect(isLive(id)).toBe(true);
    b.remove();
    expect(isLive(id)).toBe(false);
  });
});

describe("grounder", () => {
  it("grounds by elementId", () => {
    document.body.innerHTML = `<button>Search</button>`;
    const [b] = indexAll(document);
    const id = idOf(b)!;
    const g = groundTarget({ elementId: id });
    expect(g.status).toBe("ok");
    expect(g.elementId).toBe(id);
  });

  it("grounds by role + accessible name", () => {
    document.body.innerHTML = `<input type="search" placeholder="Query">`;
    const g = groundTarget({ role: "searchbox", name: "Query" });
    expect(g.status).toBe("ok");
  });

  it("reports stale ids as not_found", () => {
    expect(groundTarget({ elementId: "el_999" }).status).toBe("not_found");
  });

  it("reports ambiguity when several elements match a name", () => {
    document.body.innerHTML = `<button>Save</button><button aria-label="Save">x</button>`;
    indexAll(document);
    const g = groundTarget({ role: "button", name: "Save" });
    expect(g.status).toBe("ambiguous");
  });
});

describe("dom-reader / executor integration", () => {
  it("buildObservation includes indexed elements with ids", () => {
    document.body.innerHTML = `<input type="search" placeholder="Query"><button>Search</button>`;
    const obs = buildObservation(1);
    expect(obs.elements.length).toBe(2);
    expect(obs.elements.every((e) => e.id.startsWith("el_"))).toBe(true);
    expect(obs.url).toBe("http://localhost:3000/");
  });

  it("executeAction types into a grounded element and yields a hint", async () => {
    document.body.innerHTML = `<input type="text" id="q">`;
    const g = groundTarget({ role: "textbox", name: "" });
    expect(g.status).toBe("ok");
    const result = await executeAction(
      { action: "type", target: { elementId: g.elementId }, text: "hello" },
    );
    expect(result.ok).toBe(true);
    expect(result.hint!.value).toBe("hello");
    const input = document.getElementById("q") as HTMLInputElement;
    expect(input.value).toBe("hello");
  });

  it("executeAction refuses stale targets", async () => {
    const result = await executeAction({ action: "click", target: { elementId: "el_001" } });
    expect(result.ok).toBe(false);
  });
});

describe("Part 6 — content pipeline over the fixed bridge (observe → ground → act → re-observe)", () => {
  it("runs the full loop against the same live DOM", async () => {
    document.body.innerHTML = `
      <form><input type="search" placeholder="Query"><button>Search</button></form>`;

    const first = buildObservation(1);
    expect(first.pageType).toBe("search");
    const boxId = first.elements.find((e) => e.type === "search")!.id;

    // Ground by the observed id and act.
    const g = groundTarget({ elementId: boxId });
    expect(g.status).toBe("ok");
    const acted = await executeAction({ action: "type", target: { elementId: boxId }, text: "tutorial" });
    expect(acted.ok).toBe(true);

    // Re-observe re-reads the live DOM with a still-valid index.
    const second = buildObservation(1);
    expect(second.elements.length).toBe(2);
    expect(groundTarget({ elementId: boxId }).status).toBe("ok");
    const input = document.querySelector("input[type=search]") as HTMLInputElement;
    expect(input.value).toBe("tutorial");
  });

  it("PageObserver serves a cached snapshot only until invalidated", async () => {
    document.body.innerHTML = `<input type="search">`;
    const observer = new PageObserver(() => {});
    observer.start(1);

    const live = observer.observe();
    expect(live.freshness).toBe("live");
    expect(live.snapshot.elements.length).toBe(1);

    // No mutation → same cached snapshot, now marked stale (agent re-plans).
    const stale = observer.observe();
    expect(stale.freshness).toBe("stale");
    expect(stale.snapshot).toBe(live.snapshot);

    // Invalidate → next observe is fresh and reflects reality.
    observer.invalidate();
    const refetched = observer.observe();
    expect(refetched.freshness).toBe("live");
    observer.stop();
  });
});
describe("stale index regression (§19 — YouTube DOM mutation)", () => {
  it("clearIndex drops every mapping so rebuilt ids actually resolve", () => {
    document.body.innerHTML = `<button>Go</button>`;
    const [btn] = indexAll(document);
    const first = idOf(btn);
    expect(first).toBeTruthy();
    expect(resolveId(first!)).toBe(btn);

    // A DOM mutation clears the index (PageObserver behavior).
    clearIndex();
    expect(resolveId(first!)).toBeNull();

    // The rebuilt observation re-registers live ids — grounding succeeds
    // instead of failing forever as "not_found".
    const rebuilt = buildObservation(1);
    expect(rebuilt.elements.length).toBeGreaterThan(0);
    const id = rebuilt.elements[0].id;
    expect(resolveId(id)).not.toBeNull();
    expect(isLive(id)).toBe(true);
    expect(groundTarget({ elementId: id }).status).toBe("ok");
  });
});

describe("content bridge async responses (§F — execution results must arrive)", () => {
  it("CTX_EXECUTE keeps the message channel open and delivers the real result", async () => {
    (globalThis as Record<string, unknown>).chrome ??= { runtime: {} };
    const { handleMessage } = await import("@/content/main");
    document.body.innerHTML = `<input type="search" aria-label="Search">`;
    const [input] = indexAll(document);
    const id = idOf(input);
    expect(id).toBeTruthy();

    let response: unknown = null;
    const keptOpen = handleMessage(
      { type: "CTX_EXECUTE", payload: { action: { action: "type", target: { elementId: id }, text: "tutorial" } } },
      {},
      (r: unknown) => { response = r; },
    );
    // MV3 drops async responses unless the listener returns true.
    expect(keptOpen).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(response).toMatchObject({ type: "CTX_EXECUTE_RESULT", payload: { ok: true, hint: { value: "tutorial" } } });
    expect((input as HTMLInputElement).value).toBe("tutorial");
  });

  it("CTX_OBSERVE keeps the channel open and delivers a settled snapshot", async () => {
    (globalThis as Record<string, unknown>).chrome ??= { runtime: {} };
    const { handleMessage } = await import("@/content/main");
    document.body.innerHTML = `<button>Tutorial</button>`;
    let response: unknown = null;
    const keptOpen = handleMessage({ type: "CTX_OBSERVE" }, {}, (r: unknown) => { response = r; });
    // Render-aware read is async (same pattern as CTX_EXECUTE): the MV3
    // channel must stay open until the settled snapshot is delivered.
    expect(keptOpen).toBe(true);
    const t0 = Date.now();
    while (response === null && Date.now() - t0 < 5000) {
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(response).toMatchObject({ type: "CTX_OBSERVE_RESULT" });
  }, 10000);
});

describe("stale-id semantic re-grounding", () => {
  it("re-grounds by role+name when the id went stale after a re-render", () => {
    document.body.innerHTML = `<button>Home</button><button>Python compiler tutorial part 1</button>`;
    const els = indexAll(document);
    const staleId = idOf(els[1])!;
    // The page re-renders with fewer nodes: the old id neither resolves
    // nor gets reused for the surviving content.
    clearIndex();
    document.body.innerHTML = `<button>Python compiler tutorial part 1</button>`;
    indexAll(document);
    expect(resolveId(staleId)).toBeNull();
    const g = groundTarget({ elementId: staleId, role: "button", name: "Python compiler tutorial part 1" });
    expect(g.status).toBe("ok");
    expect(resolveId(g.elementId!)).not.toBeNull();
  });

  it("still fails honestly with a bare stale id (no semantics to fall back on)", () => {
    document.body.innerHTML = `<button>Home</button><button>Go</button>`;
    const els = indexAll(document);
    const staleId = idOf(els[1])!;
    clearIndex();
    document.body.innerHTML = `<button>Home</button>`;
    indexAll(document);
    expect(resolveId(staleId)).toBeNull();
    const g = groundTarget({ elementId: staleId });
    expect(g.status).toBe("not_found");
  });
});

describe("press_key Enter is a verified submission, not a blind dispatch", () => {
  it("Enter with no focused element fails instead of typing into the void", async () => {
    const { executeAction } = await import("@/content/executor");
    document.body.innerHTML = `<input type="search" aria-label="Search">`;
    // Deliberately unfocused: activeElement is <body>.
    const result = await executeAction({ action: "press_key", key: "Enter" } as never);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("no_focused_element");
  });

  it("Enter dispatched with no page effect fails honestly (dispatch is not success)", async () => {
    const { executeAction } = await import("@/content/executor");
    document.body.innerHTML = `<input type="search" aria-label="Search">`;
    const input = document.querySelector("input") as HTMLInputElement;
    input.focus();
    const seen: string[] = [];
    input.addEventListener("keydown", (e) => seen.push((e as KeyboardEvent).key));
    const result = await executeAction({ action: "press_key", key: "Enter" } as never);
    // The keystroke really was dispatched to the focused input…
    expect(seen).toEqual(["Enter"]);
    // …but nothing on the page reacted and no submit button exists.
    expect(result.ok).toBe(false);
    expect(result.error).toBe("submit_no_effect");
  });

  it("Enter that changes the page reports ok", async () => {
    const { executeAction } = await import("@/content/executor");
    document.body.innerHTML = `<input type="search" aria-label="Search">`;
    const input = document.querySelector("input") as HTMLInputElement;
    input.focus();
    input.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Enter") {
        document.body.insertAdjacentHTML("beforeend", `<div class="results">results here</div>`);
      }
    });
    const result = await executeAction({ action: "press_key", key: "Enter" } as never);
    expect(result).toMatchObject({ ok: true });
  });

  it("Enter falls back to the search button when key dispatch does nothing", async () => {
    const { executeAction } = await import("@/content/executor");
    document.body.innerHTML = `<input type="search" aria-label="Search"><button aria-label="Search">Go</button>`;
    const input = document.querySelector("input") as HTMLInputElement;
    input.focus();
    document.querySelector("button")!.addEventListener("click", () => {
      document.body.insertAdjacentHTML("beforeend", `<div class="results">results here</div>`);
    });
    const result = await executeAction({ action: "press_key", key: "Enter" } as never);
    expect(result).toMatchObject({ ok: true, hint: { text: "submitted via button" } });
  });
});
