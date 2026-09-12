/* ------------------------------------------------------------------ *
 * Page events — dynamic website detection. MutationObserver + URL
 * change + scroll + visibility, throttled, emitted as compact signals
 * so the agent can mark observations stale and re-observe.
 * ------------------------------------------------------------------ */

export type PageChangeKind = "mutation" | "navigation" | "scroll" | "visibility";

type Emitter = (kind: PageChangeKind, url?: string) => void;

function throttle(fn: () => void, ms: number): () => void {
  let pending = false;
  return () => {
    if (pending) return;
    pending = true;
    window.setTimeout(() => {
      pending = false;
      fn();
    }, ms);
  };
}

export function trackPageChanges(emit: Emitter): () => void {
  const teardowns: Array<() => void> = [];

  let lastHref = location.href;

  const notifyNav = throttle(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      emit("navigation", location.href);
    }
  }, 350);

  // History API interception (SPAs).
  const patch = (name: "pushState" | "replaceState") => {
    const hist = history;
    const original = hist[name].bind(hist) as (...args: unknown[]) => void;
    hist[name] = ((...args: unknown[]) => {
      const result = original(...args);
      notifyNav();
      return result;
    }) as typeof hist.pushState;
    teardowns.push(() => {
      hist[name] = original as typeof hist.pushState;
    });
  };
  patch("pushState");
  patch("replaceState");

  window.addEventListener("popstate", notifyNav);
  teardowns.push(() => window.removeEventListener("popstate", notifyNav));
  window.addEventListener("hashchange", notifyNav);
  teardowns.push(() => window.removeEventListener("hashchange", notifyNav));

  const observer = new MutationObserver(
    throttle(() => emit("mutation"), 500),
  );
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    // Title/text stamping (polymer-style renderers fill textContent and
    // attributes AFTER inserting shells): without these, a "quiet" DOM can
    // still be half-painted. The settle cap bounds busy pages.
    attributes: true,
    characterData: true,
  });
  teardowns.push(() => observer.disconnect());

  const scroll = throttle(() => emit("scroll"), 700);
  window.addEventListener("scroll", scroll, { passive: true });
  teardowns.push(() => window.removeEventListener("scroll", scroll));

  document.addEventListener("visibilitychange", () => emit("visibility"));
  teardowns.push(() => document.removeEventListener("visibilitychange", () => emit("visibility")));

  return () => {
    teardowns.forEach((f) => f());
  };
}