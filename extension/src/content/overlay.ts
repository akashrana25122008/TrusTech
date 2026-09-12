/* ------------------------------------------------------------------ *
 * AgentOverlay — shadow-root visual layer pinned over the page.
 * Draws a glowing bounding marker + label on the element the agent is
 * acting on, an animated beam from the panel edge, and a status pill.
 * Isolated from page CSS via a closed shadow root.
 * ------------------------------------------------------------------ */

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const FALLBACK_SELECTORS: Record<string, string> = {
  type: 'input[type="search"], input[type="text"], input, textarea',
  click: "button, a, input[type=submit], [role=button]",
  scroll: "main, article, body",
  select: "select, [role=listbox]",
};

export function findElement(selector?: string): Element | null {
  if (!selector) return null;
  try {
    const candidates = Array.from(document.querySelectorAll<Element>(selector));
    const visible = candidates.filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    return visible[0] ?? candidates[0] ?? null;
  } catch {
    return null;
  }
}

export function fallbackElement(kind: string): Element {
  const list = Array.from(document.querySelectorAll<Element>(FALLBACK_SELECTORS[kind] ?? "a"));
  return list.find((el) => el.getBoundingClientRect().width > 0) ?? document.body;
}

export class AgentOverlay {
  private readonly host!: HTMLElement;
  private readonly root!: ShadowRoot;
  private readonly marker!: HTMLDivElement;
  private readonly label!: HTMLDivElement;
  readonly beam!: HTMLDivElement;
  private readonly pill!: HTMLDivElement;
  private readonly clearTimers: number[] = [];

  constructor() {
    this.host = document.createElement("trustech-agent");
    this.host.style.cssText =
      "all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;font-family:-apple-system,'SF Pro Display',Inter,system-ui,sans-serif;";
    document.documentElement.appendChild(this.host);

    this.root = this.host.attachShadow({ mode: "open" });
    this.root.innerHTML = `
      <style>
        :host { all: initial; }
        .mk { position:fixed; border:1.5px solid rgba(90,220,255,.9); border-radius:8px;
              box-shadow:0 0 0 3px rgba(90,220,255,.12), 0 0 26px rgba(90,220,255,.35),
                          inset 0 0 18px rgba(90,220,255,.10);
              opacity:0; transition:opacity .18s ease, top .12s ease, left .12s ease,
                     width .12s ease, height .12s ease;
              pointer-events:none; }
        .mk.eyelid { border-color:rgba(139,123,255,.85);
                     box-shadow:0 0 0 3px rgba(139,123,255,.1), 0 0 26px rgba(139,123,255,.3),
                     inset 0 0 18px rgba(139,123,255,.08); }
        .mk .eyes { position:absolute; top:-7px; right:8px; display:flex; gap:3px; }
        .mk .eyes i { width:3px; height:3px; border-radius:50%; background:#8fe8ff;
                      box-shadow:0 0 6px #8fe8ff; }
        .lb { position:fixed; padding:4px 9px; border-radius:7px; font-size:11px; font-weight:600;
              letter-spacing:.02em; color:#eaf6ff; background:rgba(8,14,26,.92);
              border:1px solid rgba(90,180,255,.4); box-shadow:0 6px 22px rgba(0,0,0,.45);
              backdrop-filter:blur(8px); white-space:nowrap; opacity:0;
              transform:translateY(6px); transition:all .18s ease; pointer-events:none; }
        .lb.show { opacity:1; transform:none; }
        .bm { position:fixed; left:0; top:0; width:100%; height:100%; opacity:0;
              transition:opacity .25s ease; pointer-events:none;
              background:
                linear-gradient(to bottom left, rgba(55,216,255,0) 0%, rgba(55,216,255,.04) 50%, rgba(55,216,255,0) 100%),
                radial-gradient(circle at 0 0, rgba(120,220,255,.25), transparent 28%);
              -webkit-mask-image:linear-gradient(180deg,rgba(0,0,0,.9),transparent 70%);
              mask-image:linear-gradient(180deg,rgba(0,0,0,.9),transparent 70%); }
        .bm.on { opacity:1; }
        .pl { position:fixed; top:14px; right:14px; display:flex; align-items:center; gap:7px;
              padding:6px 10px; border-radius:99px; font-size:11px; font-weight:650;
              letter-spacing:.03em; color:#cfeaff; background:rgba(7,13,25,.88);
              border:1px solid rgba(90,180,255,.35); box-shadow:0 8px 26px rgba(0,0,0,.5);
              backdrop-filter:blur(10px); opacity:0; transform:translateY(-8px);
              transition:all .25s ease; pointer-events:none; }
        .pl.show { opacity:1; transform:none; }
        .pl i { width:7px; height:7px; border-radius:50%; background:#37d8ff;
                box-shadow:0 0 10px #37d8ff; animation:pl 1.6s ease-in-out infinite; }
        @keyframes pl { 0%,100%{opacity:.5} 50%{opacity:1} }
      </style>
      <div class="mk"><span class="eyes"><i></i><i></i></span></div>
      <div class="lb"></div>
      <div class="bm"></div>
      <div class="pl"><i></i><span>AI Agent</span></div>
    `;
    this.marker = this.root.querySelector(".mk")!;
    this.label = this.root.querySelector(".lb")!;
    this.beam = this.root.querySelector(".bm")!;
    this.pill = this.root.querySelector(".pl")!;
  }

  private setRect(el: Element): Rect {
    const r = el.getBoundingClientRect();
    const rect: Rect = { x: r.left, y: r.top, w: r.width, h: r.height };
    this.marker.style.top = `${rect.y}px`;
    this.marker.style.left = `${rect.x}px`;
    this.marker.style.width = `${rect.w}px`;
    this.marker.style.height = `${rect.h}px`;
    this.marker.style.opacity = "1";
    return rect;
  }

  highlight(kind: string, label: string, selector?: string, dialog = false): void {
    const el = findElement(selector) ?? fallbackElement(kind);
    const rect = this.setRect(el);
    this.marker.classList.toggle("eyelid", kind === "type");

    this.label.textContent = label;
    const lx = Math.min(Math.max(rect.x, 8), window.innerWidth - 180);
    const ly = rect.y > 40 ? rect.y - 34 : rect.y + rect.h + 8;
    this.label.style.left = `${lx}px`;
    this.label.style.top = `${ly}px`;
    this.label.classList.add("show");
    this.beam.classList.add("on");

    this.schedule(() => {
      this.label.classList.remove("show");
      this.marker.style.opacity = "0";
      this.beam.classList.remove("on");
    }, dialog ? 2600 : 1800);
  }

  clear(): void {
    this.label.classList.remove("show");
    this.marker.style.opacity = "0";
    this.beam.classList.remove("on");
  }

  setState(pill: string | null): void {
    if (!pill) {
      this.pill.classList.remove("show");
      return;
    }
    this.pill.querySelector("span")!.textContent = pill;
    this.pill.classList.add("show");
  }

  private schedule(fn: () => void, ms: number): void {
    this.clearTimers.push(window.setTimeout(fn, ms));
  }

  dispose(): void {
    this.clearTimers.forEach((t) => clearTimeout(t));
    this.host.remove();
  }
}