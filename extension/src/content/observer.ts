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

  constructor(private emitSignal: (kind: PageChangeKind, url?: string) => void) {}

  start(tabId: number): void {
    this.tabId = tabId;
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
    this.emitSignal(kind, url);
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