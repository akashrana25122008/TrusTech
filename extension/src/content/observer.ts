/* ------------------------------------------------------------------ *
 * PageObserver — holds the latest observation and knows how fresh it
 * is. The agent always reads the freshest snapshot and re-observes on
 * any DOM mutation, so a stale plan never steers reality.
 * ------------------------------------------------------------------ */

import type { ObservationSnapshot } from "@/shared/messages";
import { buildObservation } from "./dom-reader";
import { trackPageChanges, type PageChangeKind } from "./page-events";
import { clearIndex } from "./indexer";

export type Freshness = "live" | "stale";

export class PageObserver {
  private snapshot: ObservationSnapshot | null = null;
  private tabId = -1;
  private teardown: (() => void) | null = null;
  /** Last DOM/page activity seen (any tracked change kind). */
  private lastActivity = 0;

  constructor(private emitSignal: (kind: PageChangeKind, url?: string) => void) {}

  start(tabId: number): void {
    this.tabId = tabId;
    this.lastActivity = Date.now();
    this.teardown = trackPageChanges((kind, url) => this.markChanged(kind, url));
  }

  stop(): void {
    this.teardown?.();
    this.teardown = null;
    this.snapshot = null;
  }

  private markChanged(kind: PageChangeKind, url?: string): void {
    // The page moved under us: any stored ids and text are suspect.
    if (kind === "mutation") clearIndex();
    this.snapshot = null;
    this.lastActivity = Date.now();
    this.emitSignal(kind, url);
  }

  /**
   * Wait until the page stops mutating (render quiescence) or the cap
   * expires. Progressive renderers (SPA result lists, polymer stamping)
   * otherwise hand the planner half-painted snapshots — e.g. a results
   * page whose video links have no names yet. Always bounded; resolves
   * false on cap so callers proceed with the freshest available read.
   */
  async settled(quietMs = 600, capMs = 2500): Promise<boolean> {
    const t0 = Date.now();
    for (;;) {
      const idleFor = Date.now() - this.lastActivity;
      if (idleFor >= quietMs) return true;
      if (Date.now() - t0 >= capMs) return false;
      await new Promise<void>((r) => window.setTimeout(r, 150));
    }
  }

  /** Fresh snapshot for the agent (freshness: live when unchanged). */
  observe(): { snapshot: ObservationSnapshot; freshness: Freshness } {
    if (this.snapshot) {
      return { snapshot: this.snapshot, freshness: "stale" };
    }
    this.snapshot = buildObservation(this.tabId);
    return { snapshot: this.snapshot, freshness: "live" };
  }

  invalidate(): void {
    this.snapshot = null;
  }
}